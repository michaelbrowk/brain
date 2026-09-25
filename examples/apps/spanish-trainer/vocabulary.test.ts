import { describe, expect, it } from "vitest";
import {
  addDays,
  applyAnswer,
  DEFAULT_SCRIPTS,
  descendantsOf,
  dueRows,
  extractVocabulary,
  isDue,
  mergeWordRows,
  nextInterval,
  parseWordsTable,
  readVocabulary,
  renderWordsTable,
  SCRIPT_NAMES,
} from "./vocabulary.js";

describe("reading vocabulary out of a page", () => {
  it("reads a markdown table", () => {
    const md = ["| Spanish | Русский |", "| --- | --- |", "| hola | привет |", "| adios | пока |"].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "hola", translation: "привет" },
      { word: "adios", translation: "пока" },
    ]);
  });

  it("reads a word and its translation on one line", () => {
    const md = ["hola — привет", "adios - пока", "gracias – спасибо"].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "hola", translation: "привет" },
      { word: "adios", translation: "пока" },
      { word: "gracias", translation: "спасибо" },
    ]);
  });

  it("reads a bulleted list of the same", () => {
    const md = ["- hola — привет", "* adios — пока", "+ gracias — спасибо"].join("\n");
    expect(extractVocabulary(md)).toHaveLength(3);
  });

  it("takes nothing from prose, a heading or a fence", () => {
    const md = [
      "# Spanish - my notes",
      "",
      "I am learning - slowly.",
      "",
      "```",
      "hola — привет",
      "```",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([]);
  });

  it("takes a pair somebody put a full stop after", () => {
    // The sentence guard is there for `I am learning - slowly.`, and it used
    // to cost this line too. A full stop is what a person writes at the end
    // of a list item; it is not what makes the line prose. Length is.
    expect(extractVocabulary("adios — пока.")).toEqual([
      { word: "adios", translation: "пока" },
    ]);
    expect(extractVocabulary("- gracias — спасибо!")).toEqual([
      { word: "gracias", translation: "спасибо" },
    ]);
    expect(extractVocabulary("buenos dias — доброе утро.")).toEqual([
      { word: "buenos dias", translation: "доброе утро" },
    ]);
  });

  it("still takes nothing from a sentence that happens to hold a dash", () => {
    expect(extractVocabulary("I am learning - slowly.")).toEqual([]);
    expect(extractVocabulary("The trainer reads them - all three of them.")).toEqual([]);
  });

  it("does not take the table's own header row", () => {
    const md = ["| word | translation |", "| --- | --- |", "| hola | привет |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "hola", translation: "привет" }]);
  });

  it("reads one word once however many pages name it", () => {
    const rows = [...extractVocabulary("hola — привет"), ...extractVocabulary("hola — здравствуй")];
    const table = renderWordsTable(
      rows.map((row) => ({ ...row, status: "new" as const, seen: 0, next: "" })),
    );
    expect(parseWordsTable(table)).toHaveLength(1);
  });
});

/** THE THREE THINGS THE READER GOT WRONG ON A REAL NOTEBOOK.
 *
 *  The pages above are the ones this file invented. The owner's own Spanish
 *  pages are bolder, bilingual and full of grammar, and on those the reader
 *  put three kinds of rubbish into the deck: emphasis marks carried into the
 *  card, a table's header row drilled as a pair because its cells are Russian
 *  rather than English, and whole grammar tables read as vocabulary because a
 *  conjugation looks exactly like a pair.
 *
 *  The rows below are the ones that were measured, spelled as they sit on the
 *  pages. */
describe("a page the owner wrote rather than one this file invented", () => {
  it("takes the emphasis off both sides", () => {
    const md = [
      "| Испанский | Русский |",
      "| --- | --- |",
      "| **yo tengo** | у меня есть |",
      "| **Me gusta** bailar | инфинитив |",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "yo tengo", translation: "у меня есть" },
      { word: "Me gusta bailar", translation: "инфинитив" },
    ]);
  });

  it("keeps a parenthesis, which is spelling rather than emphasis", () => {
    const md = [
      "| Palabra | Перевод |",
      "| --- | --- |",
      "| Acostarse (me acuesto) | ложиться спать |",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "Acostarse (me acuesto)", translation: "ложиться спать" },
    ]);
  });

  it("reads a bullet line once the marks come off", () => {
    const line = "- **ningún** (м.р.) / **ninguna** (ж.р.) — «никакой / никакая»";
    expect(extractVocabulary(line)).toEqual([
      { word: "ningún (м.р.) / ninguna (ж.р.)", translation: "«никакой / никакая»" },
    ]);
  });

  it("skips the header row whatever language its cells are in", () => {
    // The row before the rule row is the header. Nothing about the words in
    // it says so, and on these pages they are Russian, which is why the
    // English list alone let four of them into the deck.
    const md = ["| Испанский | Русский |", "| --- | --- |", "| hola | привет |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "hola", translation: "привет" }]);
  });

  it("skips a header the script rule would have let through", () => {
    // `Palabra` is Spanish and `Перевод` is Russian, so this header is a
    // well-formed pair by every rule but the structural one.
    const md = ["| Palabra | Перевод |", "| --- | --- |", "| hola | привет |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "hola", translation: "привет" }]);
  });

  it("still knows an English header in a table with no rule row", () => {
    const md = ["| word | translation |", "| hola | привет |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "hola", translation: "привет" }]);
  });

  it("takes nothing out of a conjugation table", () => {
    // A conjugation is Spanish on both sides, and a numbering column is
    // Russian on both. Neither is a word to learn.
    const md = [
      "| Лицо | gustar |",
      "| --- | --- |",
      "| 1-е | -ar |",
      "| tener | tengo |",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([]);
  });

  it("takes only the row the bargain cannot reach out of a table of possessives", () => {
    // `yo (мой)` carries the Russian on the word side, so the pair is Spanish
    // to Spanish and goes. `tú (твой)` is the row the bargain does not reach:
    // both sides carry both scripts, so it still reads as a pair. Naming it
    // here is cheaper than a rule that would cost real pairs.
    const md = [
      "| Кому принадлежит | Ед. число |",
      "| --- | --- |",
      "| yo (мой) | **mi** |",
      "| tú (твой) | **tu** (без акцента!) |",
    ].join("\n");
    expect(extractVocabulary(md)).toEqual([
      { word: "tú (твой)", translation: "tu (без акцента!)" },
    ]);
  });
});

/** THE PAIR OF SCRIPTS IS A SETTING, NOT A LAW.
 *
 *  Latin on the word side and anything but Latin on the translation side is
 *  Michael's notebook, and it was written into the reader. A notebook kept in
 *  Spanish and English got nothing out of it, and so did a Greek one and an
 *  Arabic one. The pair is an argument now, the app keeps it in `state`, and
 *  the default is the old bargain, so the cases above are still read the way
 *  they were measured.
 *
 *  `not-<script>` is the translation side the head calls "any other than the
 *  word's": any letter that is not of that script. */
describe("the pair of scripts the owner named", () => {
  it("defaults to the bargain Michael's notebook was read on", () => {
    expect(DEFAULT_SCRIPTS).toEqual({ wordScript: "Latin", translationScript: "not-Latin" });
    expect(extractVocabulary("hola — привет")).toEqual([{ word: "hola", translation: "привет" }]);
    expect(extractVocabulary("hola — привет", DEFAULT_SCRIPTS)).toEqual([
      { word: "hola", translation: "привет" },
    ]);
  });

  it("reads a notebook kept in Spanish and English once both sides are Latin", () => {
    expect(
      extractVocabulary("hola — hello", { wordScript: "Latin", translationScript: "Latin" }),
    ).toEqual([{ word: "hola", translation: "hello" }]);
    // The reason the setting exists: under the default this page is empty.
    expect(extractVocabulary("hola — hello")).toEqual([]);
  });

  it("reads every script the head offers on the translation side", () => {
    const notebooks = [
      ["Cyrillic", "привет"],
      ["Greek", "γεια"],
      ["Arabic", "مرحبا"],
      ["Hebrew", "שלום"],
      ["Han", "你好"],
      ["Kana", "こんにちは"],
      ["Kana", "コンニチハ"],
      ["Hangul", "안녕"],
    ];
    for (const [translationScript, translation] of notebooks) {
      expect(
        extractVocabulary(`hola — ${translation}`, { wordScript: "Latin", translationScript }),
      ).toEqual([{ word: "hola", translation }]);
    }
  });

  it("reads a notebook whose words are Cyrillic and whose translations are Latin", () => {
    const scripts = { wordScript: "Cyrillic", translationScript: "Latin" };
    expect(extractVocabulary("привет — hola", scripts)).toEqual([
      { word: "привет", translation: "hola" },
    ]);
    expect(extractVocabulary("hola — привет", scripts)).toEqual([]);
  });

  it("reads `any other than the word's` against the word's own script", () => {
    const scripts = { wordScript: "Cyrillic", translationScript: "not-Cyrillic" };
    expect(extractVocabulary("привет — hola", scripts)).toEqual([
      { word: "привет", translation: "hola" },
    ]);
    expect(extractVocabulary("привет — здравствуй", scripts)).toEqual([]);
  });

  it("keeps a conjugation out of the deck under either pair, and says what it lets in", () => {
    const md = ["| Лицо | gustar |", "| --- | --- |", "| 1-е | -ar |", "| tener | tengo |"].join(
      "\n",
    );
    // A conjugation is Spanish on both sides, so neither pair reaches it.
    expect(extractVocabulary(md, { wordScript: "Latin", translationScript: "Cyrillic" })).toEqual(
      [],
    );
    // Reversing the pair is the owner saying their words are Russian and the
    // translations Latin, and a numbering column is then exactly that shape.
    // The rule is about the two scripts and nothing else; a table it cannot
    // tell from a vocabulary is the price, and the README names it.
    expect(extractVocabulary(md, { wordScript: "Cyrillic", translationScript: "Latin" })).toEqual([
      { word: "1-е", translation: "-ar" },
    ]);
  });

  it("falls back to the default for a script name nothing defines", () => {
    // The setting is JSON on the owner's own disk, so a hand edit that spells
    // a script wrong is a thing that happens. Reading it as the default costs
    // them a setting they thought they had changed; refusing it would empty
    // their deck and say nothing about why.
    expect(
      extractVocabulary("hola — привет", { wordScript: "Klingon", translationScript: "not-Latin" }),
    ).toEqual([{ word: "hola", translation: "привет" }]);
  });

  it("names the scripts the head offers, in the order it offers them", () => {
    expect(SCRIPT_NAMES).toEqual([
      "Latin",
      "Cyrillic",
      "Greek",
      "Arabic",
      "Hebrew",
      "Han",
      "Kana",
      "Hangul",
    ]);
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
    const md = ["| Spanish | Русский |", "| --- | --- |", "| o\\|u | или |"].join("\n");
    expect(extractVocabulary(md)).toEqual([{ word: "o|u", translation: "или" }]);
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

const TODAY = "2026-09-22";
const word = (over: Partial<{ word: string; translation: string; status: "new" | "learning" | "known"; seen: number; next: string }> = {}) => ({
  word: "hola",
  translation: "hello",
  status: "new" as "new" | "learning" | "known",
  seen: 0,
  next: "",
  ...over,
});

/** THE RULES THE E2E USED TO BE THE ONLY WITNESS TO.
 *
 *  Spec §9 asks for a schedule, for Again to put the word back in the session
 *  and for known words to be hidden. Those were three closures inside the
 *  entry's IIFE, reachable only by driving a browser, which is why a mutation
 *  that deleted the known filter survived a green suite. They are pure, so
 *  they live here, and `build.mjs` splices them into the entry exactly as it
 *  splices the reader. */
describe("what is due", () => {
  it("never draws a word the owner has marked known", () => {
    expect(isDue(word({ status: "known" }), TODAY)).toBe(false);
    expect(isDue(word({ status: "known", next: "" }), TODAY)).toBe(false);
    expect(isDue(word({ status: "known", next: "2020-01-01" }), TODAY)).toBe(false);
  });

  it("draws a word that has never been seen", () => {
    expect(isDue(word(), TODAY)).toBe(true);
    expect(isDue(word({ status: "learning", next: "" }), TODAY)).toBe(true);
  });

  it("draws one whose date has come, and holds one whose date has not", () => {
    expect(isDue(word({ status: "learning", next: "2026-09-21" }), TODAY)).toBe(true);
    expect(isDue(word({ status: "learning", next: TODAY }), TODAY)).toBe(true);
    expect(isDue(word({ status: "learning", next: "2026-09-23" }), TODAY)).toBe(false);
  });

  it("builds the session's deck in the order the words were found", () => {
    const rows = [
      word({ word: "hola" }),
      word({ word: "adios", status: "known", seen: 9 }),
      word({ word: "gracias", status: "learning", next: "2026-12-01" }),
      word({ word: "buenos", status: "learning", next: "2026-09-01" }),
    ];
    expect(dueRows(rows, TODAY).map((row: { word: string }) => row.word)).toEqual([
      "hola",
      "buenos",
    ]);
  });
});

describe("the schedule", () => {
  it("doubles the interval with every good answer", () => {
    expect([0, 1, 2, 3, 4].map(nextInterval)).toEqual([1, 2, 4, 8, 16]);
  });

  it("stops doubling, because a date arithmetic cannot hold is not a date", () => {
    expect(nextInterval(8)).toBe(256);
    expect(nextInterval(9)).toBe(256);
    expect(nextInterval(400)).toBe(256);
  });

  it("counts days from the day it is given, across a month and a year", () => {
    expect(addDays(TODAY, 1)).toBe("2026-09-23");
    expect(addDays(TODAY, 9)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays(TODAY, 0)).toBe(TODAY);
  });
});

describe("the three answers", () => {
  it("Again puts the word back in this session and says it is being learned", () => {
    const answered = applyAnswer(word({ status: "new", seen: 1, next: "2026-09-01" }), "again", TODAY);
    expect(answered.repeat).toBe(true);
    expect(answered.row).toMatchObject({ status: "learning", seen: 2, next: "" });
    expect(isDue(answered.row, TODAY)).toBe(true);
  });

  it("Good pushes the date out by two to the power of the sightings so far", () => {
    const answered = applyAnswer(word({ status: "learning", seen: 2 }), "good", TODAY);
    expect(answered.repeat).toBe(false);
    expect(answered.row).toMatchObject({ status: "learning", seen: 3, next: "2026-09-26" });
    expect(isDue(answered.row, TODAY)).toBe(false);
  });

  it("Easy takes the word out of the rotation for good", () => {
    const answered = applyAnswer(word({ status: "learning", seen: 2 }), "easy", TODAY);
    expect(answered.repeat).toBe(false);
    expect(answered.row).toMatchObject({ status: "known", seen: 3, next: "2026-09-30" });
    expect(isDue(answered.row, TODAY)).toBe(false);
  });

  it("answers a row rather than changing the one it was handed", () => {
    const before = word({ seen: 1 });
    applyAnswer(before, "easy", TODAY);
    expect(before).toEqual(word({ seen: 1 }));
  });
});

describe("the pages a deck is read from", () => {
  const tree = [
    { id: "deck", parentId: null, title: "Spanish" },
    { id: "week1", parentId: "deck", title: "Week one" },
    { id: "day1", parentId: "week1", title: "Monday" },
    { id: "app", parentId: "deck", title: "Trainer" },
    { id: "words", parentId: "app", title: "Words" },
    { id: "elsewhere", parentId: null, title: "Private" },
  ];

  it("reads every page under the parent, however deep", () => {
    expect(descendantsOf(tree, "deck", "nothing").map((node) => node.id)).toEqual([
      "week1",
      "day1",
      "app",
      "words",
    ]);
  });

  it("leaves the app's own subtree out, so it never drills its own answers", () => {
    expect(descendantsOf(tree, "deck", "app").map((node) => node.id)).toEqual(["week1", "day1"]);
  });

  it("reads nothing at all when no parent was chosen", () => {
    expect(descendantsOf(tree, null, "app")).toEqual([]);
  });
});

describe("a Words page somebody edited by hand", () => {
  const rows = (lines: string[]) =>
    parseWordsTable(["| word | translation | status | seen | next |", "| --- | --- | --- | --- | --- |", ...lines].join("\n"));

  it("reads a header the owner capitalised as a header, not as a word", () => {
    const table = ["| Word | Translation | Status | Seen | Next |", "| --- | --- | --- | --- | --- |", "| hola | hello | new | 0 | |"].join("\n");
    expect(parseWordsTable(table)).toEqual([
      { word: "hola", translation: "hello", status: "new", seen: 0, next: "" },
    ]);
  });

  it("reads a status the owner capitalised as that status, not as new", () => {
    expect(rows(["| hola | hello | Learning | 3 | 2026-10-01 |"])[0].status).toBe("learning");
    expect(rows(["| hola | hello | KNOWN | 3 | |"])[0].status).toBe("known");
  });

  it("still reads an unfamiliar status as new rather than losing the word", () => {
    expect(rows(["| hola | hello | mastered | 3 | |"])[0].status).toBe("new");
  });

  it("drops a row with a column too many rather than reading the wrong cells", () => {
    // Six cells means somebody added a column, and `next` is then not where
    // this reader thinks it is. Dropping the row costs one word's schedule;
    // reading it wrong writes a date into the owner's page that means nothing.
    expect(rows(["| hola | hello | new | 0 | | extra |"])).toEqual([]);
    expect(rows(["| hola | hello | new | 0 |"])).toEqual([]);
  });
});

/** THE RETRY THAT USED TO THROW THE OWNER'S EDIT AWAY.
 *
 *  A `rev_conflict` means somebody wrote the page between the app's read and
 *  its write, and the only somebody who can is the owner, in the editor, with
 *  it open beside the app. Retrying with the deck the app is holding replaces
 *  what they just saved. So the fresh page is read again, parsed again, and
 *  merged: the owner owns the words, the app owns the schedule of the rows it
 *  answered in this session, and a row only one of them has is kept. */
describe("merging the owner's page with the app's session", () => {
  const app = [
    { word: "hola", translation: "hello", status: "known" as const, seen: 4, next: "2026-10-01" },
    { word: "adios", translation: "goodbye", status: "new" as const, seen: 0, next: "" },
    { word: "buenos", translation: "good", status: "learning" as const, seen: 1, next: "2026-09-24" },
  ];
  const owner = [
    { word: "hola", translation: "hi there", status: "new" as const, seen: 0, next: "" },
    { word: "adios", translation: "goodbye", status: "known" as const, seen: 7, next: "2027-01-01" },
    { word: "gracias", translation: "thanks", status: "learning" as const, seen: 2, next: "2026-09-25" },
  ];

  it("keeps the owner's correction and the app's answer on the same row", () => {
    const merged = mergeWordRows(app, owner, ["hola"]);
    expect(merged[0]).toEqual({
      word: "hola",
      translation: "hi there",
      status: "known",
      seen: 4,
      next: "2026-10-01",
    });
  });

  it("leaves a row the app did not answer entirely to the owner", () => {
    // The owner marked adios known on their phone while the app sat on it.
    // The app's `new` is not an answer, it is the absence of one.
    expect(mergeWordRows(app, owner, ["hola"])[1]).toEqual(owner[1]);
  });

  it("keeps a row only the owner has, and a row only the app has", () => {
    const merged = mergeWordRows(app, owner, ["hola"]);
    expect(merged.map((row: { word: string }) => row.word)).toEqual([
      "hola",
      "adios",
      "gracias",
      "buenos",
    ]);
    expect(merged[3]).toEqual(app[2]);
  });

  it("matches the two sides however either of them is capitalised", () => {
    const merged = mergeWordRows(
      [{ word: "Hola", translation: "hello", status: "known" as const, seen: 4, next: "2026-10-01" }],
      [{ word: "hola", translation: "hi there", status: "new" as const, seen: 0, next: "" }],
      ["HOLA"],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ translation: "hi there", status: "known", seen: 4 });
  });

  it("is the app's own table when the owner's page is empty", () => {
    expect(mergeWordRows(app, [], ["hola"])).toEqual(app);
  });

  it("changes neither side", () => {
    const before = JSON.stringify([app, owner]);
    mergeWordRows(app, owner, ["hola"]);
    expect(JSON.stringify([app, owner])).toBe(before);
  });
});

/** READING A HUNDRED PAGES THROUGH A BRIDGE THAT ALLOWS THIRTY A SECOND.
 *
 *  `components/shell/app-bridge.ts` refuses the thirty-first request in a
 *  second with `too_many`. The trainer reads every page under the chosen
 *  parent, so a deck of more than thirty source pages used to spend the
 *  budget, have the rest refused, and drop every refused page in a bare
 *  `catch { continue; }` — the owner saw a smaller word count and no reason
 *  for it. The reads are paced under the limit, a refusal is waited out once,
 *  and whatever still could not be read is counted so the app can say so. */
describe("reading the pages a deck is built from", () => {
  const pages = (count: number) =>
    Array.from({ length: count }, (_value, index) => ({ id: `p${index}`, title: `Page ${index}` }));

  function clock() {
    const waits: number[] = [];
    return { waits, wait: async (ms: number) => void waits.push(ms), now: () => 0 };
  }

  it("reads every page and keeps the words in the order it found them", async () => {
    const answers: Record<string, string> = { p0: "hola — привет", p1: "adios — пока" };
    const answered = await readVocabulary(
      pages(2),
      async (id: string) => ({ markdown: answers[id] }),
      clock(),
    );
    expect(answered.failed).toBe(0);
    expect(answered.rows).toEqual([
      { word: "hola", translation: "привет" },
      { word: "adios", translation: "пока" },
    ]);
  });

  it("waits out a too_many refusal once and then has the page", async () => {
    const timing = clock();
    let refused = false;
    const answered = await readVocabulary(
      pages(1),
      async () => {
        if (!refused) {
          refused = true;
          throw Object.assign(new Error("that app is asking too often"), { reason: "too_many" });
        }
        return { markdown: "hola — привет" };
      },
      timing,
    );
    expect(answered.failed).toBe(0);
    expect(answered.rows).toEqual([{ word: "hola", translation: "привет" }]);
    expect(timing.waits).toEqual([1000]);
  });

  it("counts a page it could not read, and reads the rest anyway", async () => {
    const answered = await readVocabulary(
      pages(3),
      async (id: string) => {
        if (id === "p1") throw Object.assign(new Error("gone"), { reason: "not_found" });
        return { markdown: "hola — привет" };
      },
      clock(),
    );
    expect(answered.failed).toBe(1);
    expect(answered.rows).toHaveLength(2);
  });

  it("counts a page that is refused twice rather than looping on it", async () => {
    const timing = clock();
    let asked = 0;
    const answered = await readVocabulary(
      pages(1),
      async () => {
        asked += 1;
        throw Object.assign(new Error("too often"), { reason: "too_many" });
      },
      timing,
    );
    expect(asked).toBe(2);
    expect(answered.failed).toBe(1);
    expect(answered.rows).toEqual([]);
  });

  it("reads the pages against the pair of scripts it was given", async () => {
    // The setting reaches the reader through here, so a trainer whose owner
    // named two Latin scripts and whose pages are Spanish and English gets a
    // deck rather than an empty one.
    const answered = await readVocabulary(
      pages(1),
      async () => ({ markdown: "hola — hello" }),
      { ...clock(), scripts: { wordScript: "Latin", translationScript: "Latin" } },
    );
    expect(answered.rows).toEqual([{ word: "hola", translation: "hello" }]);
  });

  it("holds itself under the bridge's own limit rather than being refused by it", async () => {
    const timing = clock();
    const answered = await readVocabulary(
      pages(45),
      async () => ({ markdown: "hola — привет" }),
      { ...timing, perSecond: 20 },
    );
    expect(answered.failed).toBe(0);
    // Forty-five pages, twenty a second: it paused twice, for a second each.
    expect(timing.waits).toEqual([1000, 1000]);
  });
});

/** SIXTY-SIX PAGES, EVERY TIME THE OWNER TOUCHED THE PICKER.
 *
 *  Every reload read every page under the parent again, and on Michael's own
 *  notebook that is sixty-six requests against a budget of thirty a second for
 *  pages that had not changed since the last one. The tree says when each page
 *  was last written, so a page whose `updated` has not moved is the rows it
 *  gave last time.
 *
 *  The cache is the caller's Map and it lives as long as the frame does. A
 *  reload of the app is a new Map and reads everything, which is the point: it
 *  is a cache for a session, not a copy of the notebook. */
describe("reading the same pages twice in one session", () => {
  const timing = () => ({ wait: async () => {}, now: () => 0 });
  const page = (id: string, updated?: string) => ({ id, ...(updated === undefined ? {} : { updated }) });

  function counted(markdown: string) {
    const asked: string[] = [];
    return {
      asked,
      read: async (id: string) => {
        asked.push(id);
        return { markdown };
      },
    };
  }

  it("reads a page once while its updated has not moved", async () => {
    const cache = new Map();
    const source = counted("hola — привет");
    const nodes = [page("p0", "u1")];
    const first = await readVocabulary(nodes, source.read, { ...timing(), cache });
    const second = await readVocabulary(nodes, source.read, { ...timing(), cache });
    expect(source.asked).toEqual(["p0"]);
    expect(second.rows).toEqual(first.rows);
    expect(second.failed).toBe(0);
  });

  it("reads it again once the owner has written to it", async () => {
    const cache = new Map();
    const source = counted("hola — привет");
    await readVocabulary([page("p0", "u1")], source.read, { ...timing(), cache });
    await readVocabulary([page("p0", "u2")], source.read, { ...timing(), cache });
    expect(source.asked).toEqual(["p0", "p0"]);
  });

  it("keeps nothing for a page the host did not date", async () => {
    // A host that projects fewer fields answers a tree with no `updated` on
    // it. There is then nothing to compare, and a page read once and trusted
    // for the life of the frame would be a page frozen for the life of the
    // frame.
    const cache = new Map();
    const source = counted("hola — привет");
    await readVocabulary([page("p0")], source.read, { ...timing(), cache });
    await readVocabulary([page("p0")], source.read, { ...timing(), cache });
    expect(source.asked).toEqual(["p0", "p0"]);
    expect(cache.size).toBe(0);
  });

  it("spends no pacing budget on a page it did not read", async () => {
    // Forty-five cached pages are not forty-five requests, so the second pass
    // does not wait out two seconds it has no reason to wait.
    const cache = new Map();
    const nodes = Array.from({ length: 45 }, (_value, index) => page(`p${index}`, "u1"));
    const source = counted("hola — привет");
    const waits: number[] = [];
    await readVocabulary(nodes, source.read, { ...timing(), cache, perSecond: 20 });
    await readVocabulary(nodes, source.read, {
      wait: async (ms: number) => void waits.push(ms),
      now: () => 0,
      cache,
      perSecond: 20,
    });
    expect(source.asked).toHaveLength(45);
    expect(waits).toEqual([]);
  });

  it("counts a page it could not read, and keeps nothing for it", async () => {
    const cache = new Map();
    let asked = 0;
    const read = async () => {
      asked += 1;
      throw Object.assign(new Error("gone"), { reason: "not_found" });
    };
    const answered = await readVocabulary([page("p0", "u1")], read, { ...timing(), cache });
    expect(answered.failed).toBe(1);
    expect(cache.size).toBe(0);
    await readVocabulary([page("p0", "u1")], read, { ...timing(), cache });
    expect(asked).toBe(2);
  });
});
