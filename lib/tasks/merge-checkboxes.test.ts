import { describe, expect, it, vi } from "vitest";

import * as mergeModule from "./merge-checkboxes";
import { mergeCheckboxStates } from "./merge-checkboxes";

/** Every fixture is three short bodies built from the same four lines, so a
 *  failure names the rule that broke and not the fixture that confused it. */
const body = (...lines: string[]) => lines.join("\n");

const PLANTS = "- [ ] water the plants";
const PLANTS_DONE = "- [x] water the plants";
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
