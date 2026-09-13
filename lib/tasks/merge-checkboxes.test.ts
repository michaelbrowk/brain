import { describe, expect, it, vi } from "vitest";

import * as mergeModule from "./merge-checkboxes";
import { mergeCheckboxStates } from "./merge-checkboxes";

/** Every fixture is three short bodies built from the same four lines, so a
 *  failure names the rule that broke and not the fixture that confused it. */
const body = (...lines: string[]) => lines.join("\n");

const PLANTS = "- [ ] water the plants";
const PLANTS_DONE = "- [x] water the plants";
/** The same line as Milkdown writes it back. */
const PLANTS_STAR = "* [ ] water the plants";
const CAT = "- [ ] feed the cat";
const CAT_DONE = "- [x] feed the cat";
const NOTE = "A note.";
const LONGER_NOTE = "A longer note.";

/** `merged` is the body the merge has to produce. `null` is a refusal, which
 *  the route turns into a 409 and a person resolves by hand. */
interface MergeCase {
  name: string;
  base: string;
  mine: string;
  theirs: string;
  merged: string | null;
}

const cases: MergeCase[] = [
  {
    name: "1: the server ticks a line the client left alone",
    base: body(PLANTS, CAT, NOTE),
    mine: body(PLANTS, CAT, LONGER_NOTE),
    theirs: body(PLANTS_DONE, CAT, NOTE),
    merged: body(PLANTS_DONE, CAT, LONGER_NOTE),
  },
  {
    name: "2: the server ticks a line the client rewrote",
    base: body(PLANTS, CAT),
    mine: body("- [ ] water the plants well", CAT),
    theirs: body(PLANTS_DONE, CAT),
    merged: null,
  },
  {
    name: "3: the server inserted a line",
    base: body(PLANTS),
    mine: body(PLANTS),
    theirs: body(PLANTS, CAT),
    merged: null,
  },
  {
    name: "4: the server deleted a line",
    base: body(PLANTS, CAT),
    mine: body(PLANTS, CAT),
    theirs: body(PLANTS),
    merged: null,
  },
  {
    name: "5: the server ticked and changed a word elsewhere",
    base: body(PLANTS, NOTE),
    mine: body(PLANTS, NOTE),
    theirs: body(PLANTS_DONE, "A short note."),
    merged: null,
  },
  {
    name: "6: the client inserted a line above a server tick",
    base: body(PLANTS, CAT),
    mine: body("# Notes", PLANTS, CAT),
    theirs: body(PLANTS, CAT_DONE),
    merged: body("# Notes", PLANTS, CAT_DONE),
  },
  {
    name: "7: two server ticks at once",
    base: body(PLANTS, CAT, NOTE),
    mine: body(PLANTS, CAT, LONGER_NOTE),
    theirs: body(PLANTS_DONE, CAT_DONE, NOTE),
    merged: body(PLANTS_DONE, CAT_DONE, LONGER_NOTE),
  },
  {
    name: "8: the server unticked",
    base: body(PLANTS_DONE, NOTE),
    mine: body(PLANTS_DONE, LONGER_NOTE),
    theirs: body(PLANTS, NOTE),
    merged: body(PLANTS, LONGER_NOTE),
  },
  {
    name: "9: all three bodies identical",
    base: body(PLANTS, NOTE),
    mine: body(PLANTS, NOTE),
    theirs: body(PLANTS, NOTE),
    merged: body(PLANTS, NOTE),
  },
  {
    name: "10: an empty base has nothing to preserve",
    base: "",
    mine: body(PLANTS),
    theirs: "",
    merged: body(PLANTS),
  },
  {
    name: "11: the server ticked a line the client moved",
    base: body(PLANTS, CAT, NOTE),
    mine: body(CAT, PLANTS, NOTE),
    theirs: body(PLANTS, CAT_DONE, NOTE),
    merged: null,
  },
  {
    name: "12: a tick inside a code fence is not a task line",
    base: body("```", PLANTS, "```"),
    mine: body("```", PLANTS, "```"),
    theirs: body("```", PLANTS_DONE, "```"),
    merged: null,
  },
  // The five below are not in the spec's list. Each is a way a line differ
  // written without `parseTaskLines` quietly accepts something it should not.
  {
    name: "13: a tick and a moved space on the same line",
    base: body("- [ ]  water the plants"),
    mine: body("- [ ]  water the plants"),
    theirs: body("- [x] water  the plants"),
    merged: null,
  },
  {
    name: "14: a trailing space the server added",
    base: body(PLANTS),
    mine: body(PLANTS),
    theirs: body(`${PLANTS_DONE} `),
    merged: null,
  },
  {
    name: "15: brackets flipped on a line with no bullet",
    base: body("[ ] water the plants"),
    mine: body("[ ] water the plants"),
    theirs: body("[x] water the plants"),
    merged: null,
  },
  {
    name: "16: a CRLF body keeps its line endings",
    base: `${PLANTS}\r\n${NOTE}`,
    mine: `${PLANTS}\r\n${LONGER_NOTE}`,
    theirs: `${PLANTS_DONE}\r\n${NOTE}`,
    merged: `${PLANTS_DONE}\r\n${LONGER_NOTE}`,
  },
  {
    name: "17: both sides ticked the same line, so the client touched it",
    base: body(PLANTS, NOTE),
    mine: body(PLANTS_DONE, NOTE),
    theirs: body(PLANTS_DONE, NOTE),
    merged: null,
  },
  // 18 to 21 are the two guards inside `isTokenFlip`. Each is one deleted
  // line away from a merge that copies the server's text over the client's.
  {
    name: "18: the server edited one character of the words and ticked nothing",
    base: body(PLANTS),
    mine: body(PLANTS),
    theirs: body("- [ ] water the plantz"),
    merged: null,
  },
  {
    name: "19: base is a task line, theirs at that index is not",
    base: body(PLANTS),
    mine: body(PLANTS),
    theirs: body("  [ ] water the plants"),
    merged: null,
  },
  {
    name: "20: theirs is a task line, base at that index is not",
    base: body("  [ ] water the plants"),
    mine: body("  [ ] water the plants"),
    theirs: body(PLANTS),
    merged: null,
  },
  {
    name: "21: the server flipped a token inside a code fence",
    base: body("```", PLANTS, "```", NOTE),
    mine: body("```", PLANTS, "```", LONGER_NOTE),
    theirs: body("```", PLANTS_DONE, "```", NOTE),
    merged: null,
  },
  // 22 is the cost ruling 1 accepted, and the shape an LCS would flip while
  // case 11 stayed green. Client edits above and below, tick in the middle.
  {
    name: "22: the client edited above and below an untouched ticked line",
    base: body("A.", PLANTS, "B."),
    mine: body("A edited.", PLANTS, "B edited."),
    theirs: body("A.", PLANTS_DONE, "B."),
    merged: null,
  },
  // 23 and 24: the merge matches by index and never by text. A merge that
  // searched `mine` for the line's words would tick the first of the two.
  {
    name: "23: two identical base lines, the server ticks the second",
    base: body(PLANTS, PLANTS, NOTE),
    mine: body(PLANTS, PLANTS, LONGER_NOTE),
    theirs: body(PLANTS, PLANTS_DONE, NOTE),
    merged: body(PLANTS, PLANTS_DONE, LONGER_NOTE),
  },
  {
    name: "24: two identical base lines, the server ticks the first",
    base: body(PLANTS, PLANTS, NOTE),
    mine: body(PLANTS, PLANTS, LONGER_NOTE),
    theirs: body(PLANTS_DONE, PLANTS, NOTE),
    merged: body(PLANTS_DONE, PLANTS, LONGER_NOTE),
  },
  {
    name: "25: a nested task line is ticked and its parent is not",
    base: body(PLANTS, "  - [ ] and the herbs"),
    mine: body(PLANTS, "  - [ ] and the herbs", NOTE),
    theirs: body(PLANTS, "  - [x] and the herbs"),
    merged: body(PLANTS, "  - [x] and the herbs", NOTE),
  },
  // 26 to 28: the client deleted the line the server ticked. There is no
  // index to re-apply the tick at, at any of the three positions.
  {
    name: "26: the client deleted the ticked line, first",
    base: body(PLANTS, CAT, NOTE),
    mine: body(CAT, NOTE),
    theirs: body(PLANTS_DONE, CAT, NOTE),
    merged: null,
  },
  {
    name: "27: the client deleted the ticked line, middle",
    base: body(PLANTS, CAT, NOTE),
    mine: body(PLANTS, NOTE),
    theirs: body(PLANTS, CAT_DONE, NOTE),
    merged: null,
  },
  {
    name: "28: the client deleted the ticked line, last",
    base: body(NOTE, CAT, PLANTS),
    mine: body(NOTE, CAT),
    theirs: body(NOTE, CAT, PLANTS_DONE),
    merged: null,
  },
  {
    name: "29: the client deleted a different line and the ticked one survives",
    base: body(PLANTS, CAT, NOTE),
    mine: body(PLANTS, NOTE),
    theirs: body(PLANTS_DONE, CAT, NOTE),
    merged: body(PLANTS_DONE, NOTE),
  },
  {
    name: "30: two identical base lines, the client deleted one, the server ticked the other",
    base: body(PLANTS, PLANTS, NOTE),
    mine: body(PLANTS, NOTE),
    theirs: body(PLANTS, PLANTS_DONE, NOTE),
    merged: null,
  },
  {
    name: "31: two different lines ticked at once, one by each side",
    base: body(PLANTS, CAT),
    mine: body(PLANTS, CAT_DONE),
    theirs: body(PLANTS_DONE, CAT),
    merged: body(PLANTS_DONE, CAT_DONE),
  },
  // 32 to 35: a trailing newline is a final empty line to the splitter, so it
  // counts in the line count and in the head and the tail like any other.
  {
    name: "32: all three bodies carry a trailing newline",
    base: `${body(PLANTS, NOTE)}\n`,
    mine: `${body(PLANTS, LONGER_NOTE)}\n`,
    theirs: `${body(PLANTS_DONE, NOTE)}\n`,
    merged: `${body(PLANTS_DONE, LONGER_NOTE)}\n`,
  },
  {
    name: "33: the client added a trailing newline",
    base: body(PLANTS, NOTE),
    mine: `${body(PLANTS, NOTE)}\n`,
    theirs: body(PLANTS_DONE, NOTE),
    merged: `${body(PLANTS_DONE, NOTE)}\n`,
  },
  {
    name: "34: the client removed the trailing newline",
    base: `${body(PLANTS, NOTE)}\n`,
    mine: body(PLANTS, NOTE),
    theirs: `${body(PLANTS_DONE, NOTE)}\n`,
    merged: body(PLANTS_DONE, NOTE),
  },
  {
    name: "35: the server dropped the trailing newline",
    base: `${body(PLANTS, NOTE)}\n`,
    mine: `${body(PLANTS, NOTE)}\n`,
    theirs: body(PLANTS_DONE, NOTE),
    merged: null,
  },
  // 36 is the other side of case 21's fence boundary, and it accepts.
  // `parseTaskLines` leaves four-space indented code out of scope on purpose
  // (`task-lines.ts`), so the editor, the anchor and this merge all read that
  // line as a task. Invariant 7 working, rather than a merge defect.
  {
    name: "36: a four-space indented code block is not a fence, so its tick merges",
    base: body(NOTE, "    - [ ] a code sample"),
    mine: body(LONGER_NOTE, "    - [ ] a code sample"),
    theirs: body(NOTE, "    - [x] a code sample"),
    merged: body(LONGER_NOTE, "    - [x] a code sample"),
  },
  // 37 to 41: the bullet marker. Milkdown serialises every bullet as `*`, so
  // the first editor save of a note written by hand or through MCP rewrites
  // `-` to `*` on every line. Without marker normalisation that rewrite is a
  // touched line everywhere and a concurrent tick 409s on every such note.
  {
    name: "37: the editor rewrote the bullet and the server ticked that line",
    base: body(PLANTS, NOTE),
    mine: body(PLANTS_STAR, LONGER_NOTE),
    theirs: body(PLANTS_DONE, NOTE),
    merged: body("* [x] water the plants", LONGER_NOTE),
  },
  {
    name: "38: the client's marker survives the merge, so the whole body stays one style",
    base: body(PLANTS, CAT, NOTE),
    mine: body(PLANTS_STAR, "* [ ] feed the cat", LONGER_NOTE),
    theirs: body(PLANTS_DONE, CAT_DONE, NOTE),
    merged: body("* [x] water the plants", "* [x] feed the cat", LONGER_NOTE),
  },
  {
    name: "39: the server's body carries the other marker",
    base: body(PLANTS, NOTE),
    mine: body(PLANTS, LONGER_NOTE),
    theirs: body("+ [x] water the plants", NOTE),
    merged: body(PLANTS_DONE, LONGER_NOTE),
  },
  {
    name: "40: a marker difference does not excuse an edited word",
    base: body(PLANTS),
    mine: body(PLANTS),
    theirs: body("* [x] water the plantz"),
    merged: null,
  },
  {
    name: "41: a marker change on a line that is no task line is a change",
    base: body("- a plain bullet", PLANTS),
    mine: body("- a plain bullet", PLANTS),
    theirs: body("* a plain bullet", PLANTS_DONE),
    merged: null,
  },
];

describe("mergeCheckboxStates", () => {
  for (const { name, base, mine, theirs, merged } of cases) {
    it(name, () => {
      const result = mergeCheckboxStates(base, mine, theirs);
      if (merged === null) {
        expect(result).toEqual({ ok: false });
        return;
      }
      expect(result).toEqual({ ok: true, merged });
    });
  }

  it("never invents a body: an accepted merge differs from mine only by tokens", () => {
    for (const { base, mine, theirs } of cases) {
      const result = mergeCheckboxStates(base, mine, theirs);
      if (!result.ok) continue;
      const mineLines = mine.split("\n");
      const mergedLines = result.merged.split("\n");
      expect(mergedLines).toHaveLength(mineLines.length);
      for (const [index, line] of mergedLines.entries()) {
        const original = mineLines[index];
        expect(line).toHaveLength(original.length);
        const differences = [...line].filter((char, at) => char !== original[at]).length;
        expect(differences).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reads no clock, in every export of merge-checkboxes.ts", () => {
    const exercised: Record<string, () => unknown> = {
      mergeCheckboxStates: () =>
        cases.map(({ base, mine, theirs }) => mergeCheckboxStates(base, mine, theirs)),
    };

    // A new export has to be added above, or this fails before the trap runs.
    const callable = Object.entries(mergeModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(Object.keys(exercised).sort()).toEqual(callable.sort());

    const boom = () => {
      throw new Error("lib/tasks must not read the clock");
    };
    const trap = function TrappedDate() {
      boom();
    } as unknown as DateConstructor;
    Object.assign(trap, { now: boom, parse: boom, UTC: boom });

    let ran = 0;
    let thrown: unknown = null;
    let trapArmed = false;
    vi.stubGlobal("Date", trap);
    try {
      try {
        new Date();
      } catch {
        trapArmed = true;
      }
      for (const run of Object.values(exercised)) {
        run();
        ran += 1;
      }
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(trapArmed).toBe(true);
    expect(thrown).toBeNull();
    expect(ran).toBe(Object.keys(exercised).length);
  });
});
