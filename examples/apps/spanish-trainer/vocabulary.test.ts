import { describe, expect, it } from "vitest";
import { extractVocabulary, parseWordsTable, renderWordsTable } from "./vocabulary.js";

describe("reading vocabulary out of a page", () => {
  it("reads a markdown table", () => {
    const md = ["| Spanish | English |", "| --- | --- |", "| hola | hello |", "| adios | goodbye |"].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "hola", translation: "hello" },
      { word: "adios", translation: "goodbye" },
    ]);
  });

  it("reads a word and its translation on one line", () => {
    const md = ["hola — hello", "adios - goodbye", "gracias – thanks"].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "hola", translation: "hello" },
      { word: "adios", translation: "goodbye" },
      { word: "gracias", translation: "thanks" },
    ]);
  });

  it("reads a bulleted list of the same", () => {
    const md = ["- hola — hello", "* adios — goodbye", "+ gracias — thanks"].join("\n");
    expect(extractVocabulary(md)).toHaveLength(3);
  });

  it("takes nothing from prose, a heading or a fence", () => {
    const md = [
      "# Spanish - my notes",
      "",
      "I am learning - slowly.",
      "",
      "```",
      "hola — hello",
      "```",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([]);
  });

  it("does not take the table's own header row", () => {
    const md = ["| word | translation |", "| --- | --- |", "| hola | hello |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "hola", translation: "hello" }]);
  });

  it("reads one word once however many pages name it", () => {
    const rows = [...extractVocabulary("hola — hello"), ...extractVocabulary("hola — hi")];
    const table = renderWordsTable(
      rows.map((row) => ({ ...row, status: "new" as const, seen: 0, next: "" })),
    );
    expect(parseWordsTable(table)).toHaveLength(1);
  });
});

describe("the Words page", () => {
  const rows = [
    { word: "hola", translation: "hello", status: "known" as const, seen: 4, next: "2026-09-30" },
    { word: "adios", translation: "goodbye", status: "new" as const, seen: 0, next: "" },
  ];

  it("round-trips through the markdown table it writes", () => {
    expect(parseWordsTable(renderWordsTable(rows))).toEqual(rows);
  });

  it("writes a table a person can read, with a header", () => {
    const table = renderWordsTable(rows);
    expect(table.split("\n")[0]).toBe("| word | translation | status | seen | next |");
    expect(table.split("\n")[1]).toBe("| --- | --- | --- | --- | --- |");
  });

  it("survives a page somebody edited by hand", () => {
    const table = ["| word | translation | status | seen | next |", "| --- | --- | --- | --- | --- |", "| hola | hello | known | 4 | 2026-09-30 |", "| broken row"].join("\n");
    expect(parseWordsTable(table)).toEqual([rows[0]]);
  });

  it("reads an unknown status as new rather than losing the word", () => {
    const table = ["| word | translation | status | seen | next |", "| --- | --- | --- | --- | --- |", "| hola | hello | mastered | 4 | |"].join("\n");
    expect(parseWordsTable(table)[0].status).toBe("new");
  });
});

/** THE ROW THAT USED TO DISAPPEAR EVERY TIME IT WAS WRITTEN.
 *
 *  A pipe is the table's own separator, so a word or a translation carrying
 *  one wrote a six-cell row that `parseWordsTable` then dropped. The word was
 *  re-extracted from the source page as new, drilled again, written again and
 *  dropped again, and the owner's `Words` page rendered as a broken table in
 *  the editor. Markdown's own answer is a backslash, and it is what a person
 *  hand-editing the page would write. */
describe("a cell that carries the table's own separator", () => {
  const awkward = [
    { word: "o|u", translation: "or", status: "learning" as const, seen: 2, next: "2026-10-01" },
    { word: "coma", translation: "comma, the mark", status: "new" as const, seen: 0, next: "" },
    { word: "barra", translation: "a slash | a bar", status: "known" as const, seen: 5, next: "2026-12-01" },
  ];

  it("round-trips a word and a translation that hold one", () => {
    expect(parseWordsTable(renderWordsTable(awkward))).toEqual(awkward);
  });

  it("writes it escaped, so the owner's page is still a table", () => {
    const table = renderWordsTable([awkward[0]]);
    expect(table.split("\n")[2]).toBe("| o\\|u | or | learning | 2 | 2026-10-01 |");
  });

  it("reads an escaped separator out of a source page too", () => {
    const md = ["| Spanish | English |", "| --- | --- |", "| o\\|u | or |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "o|u", translation: "or" }]);
  });

  it("keeps a cell on one line, whatever it was given", () => {
    const table = renderWordsTable([
      { word: "dos\nlineas", translation: "two lines", status: "new" as const, seen: 0, next: "" },
    ]);
    expect(table.split("\n")).toHaveLength(3);
    expect(parseWordsTable(table)[0].word).toBe("dos lineas");
  });

  it("survives a backslash of the owner's own", () => {
    const rows = [
      { word: "contra\\barra", translation: "backslash", status: "new" as const, seen: 0, next: "" },
    ];
    expect(parseWordsTable(renderWordsTable(rows))).toEqual(rows);
  });
});
