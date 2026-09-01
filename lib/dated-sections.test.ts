import { describe, expect, it } from "vitest";
import {
  orderPageIdsByTitleDate,
  parseTitleDate,
  resolveTitleDate,
  sectionPageIds,
  titleDateMs,
} from "./dated-sections";

/** Pages imported in bulk all carry the import date, not the entry date — the
 *  honest worst case for a missing-year rule. */
const IMPORTED = "2026-07-08T00:00:00.000Z";

/** A «Записи» section in the order Smart sort left it: a string sort, which
 *  reads 11 April, 14 June, 17 March, 19 April. The last five were written
 *  after the import, so they carry their own day and sit where they arrived. */
const ENTRIES = [
  { id: "apr-11", title: "Запись 11 апреля", created: IMPORTED },
  { id: "jun-14", title: "Запись 14 июня", created: IMPORTED },
  { id: "mar-17", title: "Запись 17 марта", created: IMPORTED },
  { id: "apr-19", title: "Запись 19 апреля", created: IMPORTED },
  { id: "apr-2", title: "Запись 2 апреля", created: IMPORTED },
  { id: "may-23", title: "Запись 23 мая", created: IMPORTED },
  { id: "mar-26", title: "Запись 26 марта", created: IMPORTED },
  { id: "jun-27", title: "Запись 27 июня", created: IMPORTED },
  { id: "jun-3", title: "Запись 3 июня", created: IMPORTED },
  { id: "apr-30", title: "Запись 30 апреля", created: IMPORTED },
  { id: "mar-4", title: "Запись 4 марта", created: IMPORTED },
  { id: "may-8", title: "Запись 8 мая", created: IMPORTED },
  { id: "jul-7", title: "Запись 7 июля", created: "2026-07-07T00:00:00.000Z" },
  { id: "jul-19", title: "Запись 19 июля", created: "2026-07-19T00:00:00.000Z" },
  { id: "jul-30", title: "Запись 30 июля", created: "2026-07-30T00:00:00.000Z" },
  {
    id: "aug-12",
    title: "Запись 12 августа",
    created: "2026-08-12T00:00:00.000Z",
  },
  {
    id: "aug-25",
    title: "Запись 25 августа",
    created: "2026-08-25T00:00:00.000Z",
  },
];

function titlesOf(ids: string[], pages: typeof ENTRIES) {
  const byId = new Map(pages.map((p) => [p.id, p.title] as const));
  return ids.map((id) => byId.get(id) ?? id);
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

describe("parseTitleDate — Russian months", () => {
  const genitive: [string, number][] = [
    ["Запись 9 января", 1],
    ["Запись 9 февраля", 2],
    ["Запись 9 марта", 3],
    ["Запись 9 апреля", 4],
    ["Запись 9 мая", 5],
    ["Запись 9 июня", 6],
    ["Запись 9 июля", 7],
    ["Запись 9 августа", 8],
    ["Запись 9 сентября", 9],
    ["Запись 9 октября", 10],
    ["Запись 9 ноября", 11],
    ["Запись 9 декабря", 12],
  ];

  it.each(genitive)("reads %s as a day and a month", (title, month) => {
    expect(parseTitleDate(title)).toEqual({ month, day: 9 });
  });

  it("reads the nominative form too", () => {
    expect(parseTitleDate("Запись 18 август")).toEqual({ month: 8, day: 18 });
    expect(parseTitleDate("Запись 5 май")).toEqual({ month: 5, day: 5 });
  });

  it("takes a year the title states", () => {
    expect(parseTitleDate("Запись 12 мая 2025")).toEqual({
      year: 2025,
      month: 5,
      day: 12,
    });
  });

  it("does not read a month out of a longer word", () => {
    expect(parseTitleDate("Глава 3 маятник")).toBeNull();
    expect(parseTitleDate("Раздел 7 июльский отчёт")).toBeNull();
  });
});

describe("parseTitleDate — the other supported shapes", () => {
  it("reads ISO", () => {
    expect(parseTitleDate("Standup 2026-08-25")).toEqual({
      year: 2026,
      month: 8,
      day: 25,
    });
  });

  it("reads a dotted day-first date with a four-digit year", () => {
    expect(parseTitleDate("Krisp 25.08.2026")).toEqual({
      year: 2026,
      month: 8,
      day: 25,
    });
  });

  it("reads English in both orders, with or without a year", () => {
    expect(parseTitleDate("Lesson 9 March")).toEqual({ month: 3, day: 9 });
    expect(parseTitleDate("Lesson Mar 9")).toEqual({ month: 3, day: 9 });
    expect(parseTitleDate("Lesson March 9, 2026")).toEqual({
      year: 2026,
      month: 3,
      day: 9,
    });
    expect(parseTitleDate("Lesson 9 Mar 2026")).toEqual({
      year: 2026,
      month: 3,
      day: 9,
    });
  });

  it("refuses the shapes it does not claim to support", () => {
    expect(parseTitleDate("Запись 25.08.26")).toBeNull(); // two-digit year
    expect(parseTitleDate("Запись в августе")).toBeNull(); // no day
    expect(parseTitleDate("Запись 9-16 марта")).toBeNull(); // a range
    expect(parseTitleDate("Lessons March 9-16")).toBeNull(); // a range
    expect(parseTitleDate("Отпуск 12–20 августа")).toBeNull(); // en dash
    expect(parseTitleDate("Отпуск 12—14 августа")).toBeNull(); // em dash
    expect(parseTitleDate("Lessons 9–16 March")).toBeNull();
    expect(parseTitleDate("Lessons March 9–16")).toBeNull();
    expect(parseTitleDate("Lessons March 9—16")).toBeNull();
    expect(parseTitleDate("Отпуск с 12 по 14 августа")).toBeNull(); // in words
    expect(parseTitleDate("Отпуск С 12 ПО 14 АВГУСТА")).toBeNull();
    expect(parseTitleDate("Sprint v1.9 марта")).toBeNull(); // a version
    expect(parseTitleDate("Sprint 24")).toBeNull();
    expect(parseTitleDate("Мульча")).toBeNull();
    expect(parseTitleDate("Сорта (гала, лигол, чемпион)")).toBeNull();
  });

  it("still reads the shapes around a range that are one day", () => {
    // A deadline is one day. A dash that is not between two numbers is prose.
    expect(parseTitleDate("Сдать по 14 августа")).toEqual({ month: 8, day: 14 });
    expect(parseTitleDate("Запись — 14 августа")).toEqual({ month: 8, day: 14 });
    expect(parseTitleDate("Запись 14 августа — итоги")).toEqual({
      month: 8,
      day: 14,
    });
    expect(parseTitleDate("Встреча 9 марта 14:00")).toEqual({ month: 3, day: 9 });
    expect(parseTitleDate("УРОК 9 МАРТА")).toEqual({ month: 3, day: 9 });
    expect(parseTitleDate("В среду 9 марта был урок")).toEqual({
      month: 3,
      day: 9,
    });
    expect(parseTitleDate("Q3 2026 planning")).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    expect(parseTitleDate("Запись 31 февраля")).toBeNull();
    expect(parseTitleDate("Отчёт 2026-02-30")).toBeNull();
    expect(parseTitleDate("Отчёт 30.02.2026")).toBeNull();
    expect(parseTitleDate("Запись 29 февраля 2026")).toBeNull(); // common year
    expect(parseTitleDate("Запись 29 февраля 2024")).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });
});

describe("resolveTitleDate — the missing year", () => {
  it("keeps a year the title states, ignoring when the page was written", () => {
    expect(
      iso(titleDateMs("Запись 12 мая 2024", "2026-07-08T00:00:00.000Z")),
    ).toBe("2024-05-12");
  });

  it("puts a bulk-imported entry in the year nearest its import", () => {
    expect(iso(titleDateMs("Запись 9 марта", IMPORTED))).toBe("2026-03-09");
    expect(iso(titleDateMs("Запись 25 августа", IMPORTED))).toBe("2026-08-25");
  });

  it("reaches back over New Year for a December entry written in January", () => {
    expect(iso(titleDateMs("Запись 20 декабря", "2026-01-06T09:00:00.000Z"))).toBe(
      "2025-12-20",
    );
  });

  it("reaches over New Year for an entry planned a few days ahead", () => {
    expect(iso(titleDateMs("Запись 5 января", "2025-12-30T19:00:00.000Z"))).toBe(
      "2026-01-05",
    );
  });

  it("does not reach into the year after for a date months away", () => {
    // The whole «Записи» section was imported on 8 July 2026. The nearest
    // 5 January to that day is the one in 2027 — 181 days ahead against 188
    // days back — and the rule that picked it filed a winter entry above
    // every entry of the summer. A note records what has happened.
    expect(iso(titleDateMs("Запись 5 января", IMPORTED))).toBe("2026-01-05");
    expect(iso(titleDateMs("Запись 1 июля", IMPORTED))).toBe("2026-07-01");
    // Inside the creation year the future is still fine — a section imported
    // in July keeps its August entries in the same summer.
    expect(iso(titleDateMs("Запись 25 августа", IMPORTED))).toBe("2026-08-25");
    // Thirty-one days is the edge of a plan.
    expect(iso(titleDateMs("Запись 5 января", "2025-12-05T00:00:00.000Z"))).toBe(
      "2026-01-05",
    );
    expect(iso(titleDateMs("Запись 5 января", "2025-12-04T00:00:00.000Z"))).toBe(
      "2025-01-05",
    );
  });

  it("leaves a title undated when the page has no creation date to anchor it", () => {
    expect(titleDateMs("Запись 9 марта")).toBeNull();
    expect(titleDateMs("Запись 9 марта", "not a date")).toBeNull();
  });

  it("leaves 29 February undated when no candidate year is a leap year", () => {
    expect(
      resolveTitleDate({ month: 2, day: 29 }, "2026-07-08T00:00:00.000Z"),
    ).toBeNull();
    expect(
      iso(resolveTitleDate({ month: 2, day: 29 }, "2024-03-02T00:00:00.000Z")),
    ).toBe("2024-02-29");
  });
});

describe("orderPageIdsByTitleDate", () => {
  it("reads a dated section newest first instead of alphabetically", () => {
    expect(titlesOf(orderPageIdsByTitleDate(ENTRIES), ENTRIES)).toEqual([
      "Запись 25 августа",
      "Запись 12 августа",
      "Запись 30 июля",
      "Запись 19 июля",
      "Запись 7 июля",
      "Запись 27 июня",
      "Запись 14 июня",
      "Запись 3 июня",
      "Запись 23 мая",
      "Запись 8 мая",
      "Запись 30 апреля",
      "Запись 19 апреля",
      "Запись 11 апреля",
      "Запись 2 апреля",
      "Запись 26 марта",
      "Запись 17 марта",
      "Запись 4 марта",
    ]);
  });

  it("orders across a year boundary by date, not by month number", () => {
    const pages = [
      {
        id: "dec",
        title: "Запись 20 декабря",
        created: "2026-01-06T09:00:00.000Z",
      },
      {
        id: "jan-5",
        title: "Запись 5 января",
        created: "2025-12-30T19:00:00.000Z",
      },
      {
        id: "jan-12",
        title: "Запись 12 января",
        created: "2026-01-13T09:00:00.000Z",
      },
    ];
    expect(orderPageIdsByTitleDate(pages)).toEqual(["jan-12", "jan-5", "dec"]);
  });

  it("leaves undated pages exactly where they were", () => {
    const mixed = [
      { id: "mulch", title: "Мульча", created: IMPORTED },
      { id: "mar-9", title: "Запись 9 марта", created: IMPORTED },
      { id: "tools", title: "Инструменты", created: IMPORTED },
      { id: "jun-23", title: "Запись 23 июня", created: IMPORTED },
      { id: "compost", title: "Компост", created: IMPORTED },
      { id: "apr-6", title: "Запись 6 апреля", created: IMPORTED },
    ];
    // slots 1, 3, 5 held dates and still do; slots 0, 2, 4 are untouched.
    expect(orderPageIdsByTitleDate(mixed)).toEqual([
      "mulch",
      "jun-23",
      "tools",
      "apr-6",
      "compost",
      "mar-9",
    ]);
  });

  it("returns an entirely undated section unchanged", () => {
    const undated = [
      { id: "a", title: "Мульча", created: IMPORTED },
      { id: "b", title: "Инструменты", created: IMPORTED },
      { id: "c", title: "Полив", created: IMPORTED },
    ];
    expect(orderPageIdsByTitleDate(undated)).toEqual(["a", "b", "c"]);
  });

  it("leaves a section of one alone, dated or not", () => {
    expect(
      orderPageIdsByTitleDate([
        { id: "only", title: "Запись 9 марта", created: IMPORTED },
      ]),
    ).toEqual(["only"]);
    expect(orderPageIdsByTitleDate([])).toEqual([]);
  });

  it("does not move a single dated page past its undated neighbours", () => {
    const pages = [
      { id: "intro", title: "Как заниматься", created: IMPORTED },
      { id: "cheat", title: "Шпаргалка", created: IMPORTED },
      { id: "one", title: "Запись 9 марта", created: IMPORTED },
    ];
    expect(orderPageIdsByTitleDate(pages)).toEqual(["intro", "cheat", "one"]);
  });

  it("keeps the prior order of pages that share a date", () => {
    const pages = [
      { id: "second-half", title: "Запись 9 марта (часть 2)", created: IMPORTED },
      { id: "first-half", title: "Запись 9 марта", created: IMPORTED },
      { id: "later", title: "Запись 16 марта", created: IMPORTED },
    ];
    expect(orderPageIdsByTitleDate(pages)).toEqual([
      "later",
      "second-half",
      "first-half",
    ]);
  });
});

describe("sectionPageIds", () => {
  const grouping = {
    assignments: { a: "Записи", b: "Посадки", c: "Записи", d: "Записи" },
    order: ["b", "d", "c", "a"],
  };

  it("reads a section in the order Smart sort settled on", () => {
    expect(sectionPageIds(grouping, "Записи")).toEqual(["d", "c", "a"]);
    expect(sectionPageIds(grouping, "Посадки")).toEqual(["b"]);
  });

  it("falls back to the assignment order when no order is supplied", () => {
    expect(
      sectionPageIds({ assignments: grouping.assignments }, "Записи"),
    ).toEqual(["a", "c", "d"]);
  });

  it("cannot lose, duplicate, or invent a page", () => {
    const damaged = {
      assignments: grouping.assignments,
      order: ["c", "c", "zzz"],
    };
    expect(sectionPageIds(damaged, "Записи")).toEqual(["c", "a", "d"]);
  });
});
