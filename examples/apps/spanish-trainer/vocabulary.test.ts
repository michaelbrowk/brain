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
