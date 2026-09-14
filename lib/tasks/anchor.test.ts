import { describe, expect, it, vi } from "vitest";

import * as anchorModule from "./anchor";
import { diceBigramSimilarity, resolveAnchor } from "./anchor";
import type { TaskAnchor } from "./model";
import { hashTaskText, normalizeTaskText, parseTaskLines } from "./task-lines";

/** An anchor written the way the store writes one: normalized text and the
 *  hash of that text, so a fixture can never carry a hash its text does not
 *  produce. */
function anchorFor(text: string, ordinal: number, line: number): TaskAnchor {
  const normalized = normalizeTaskText(text);
  return { text: normalized, hash: hashTaskText(normalized), ordinal, line };
}

const NOTHING_CLAIMED: ReadonlySet<number> = new Set<number>();

/** The four texts every fixture is built from. `water the plants today` and
 *  `water the plants tomorrow` both sit above the 0.6 threshold against
 *  `water the plants`, and `feed the cat` sits below it at 0.38. */
const PLANTS = "water the plants";
const PLANTS_TODAY = "water the plants today";
const PLANTS_TOMORROW = "water the plants tomorrow";
const CAT = "feed the cat";

/** Three texts chosen for where they sit against the 0.6 threshold and not
 *  for what they say. The similarities are asserted in the cases that use
 *  them, so a fixture edited by hand cannot quietly stop testing the line. */
const RENT = "pay the rent";
const RENT_BILLS = "pay the rent and the bills"; // 0.611 against RENT
const RENT_TODAY = "pay the rent today";
const RENT_NOON = "pay the rent before noon"; // 0.600 exactly against RENT_TODAY
const REPORT_NOON = "read the report before noon";
const REPORT_KEY = "read the report with the new key"; // 0.596 against REPORT_NOON

const task = (text: string, checked = false) => `- [${checked ? "x" : " "}] ${text}`;

describe("diceBigramSimilarity", () => {
  const cases: { name: string; a: string; b: string; expected: number }[] = [
    { name: "identical strings are 1", a: PLANTS, b: PLANTS, expected: 1 },
    { name: "disjoint strings are 0", a: "ab", b: "cd", expected: 0 },
    {
      name: "a shared word is not a shared string",
      a: PLANTS,
      b: CAT,
      expected: 0.3846153846153846,
    },
    { name: "an edited tail keeps most of the text", a: PLANTS, b: PLANTS_TODAY, expected: 5 / 6 },
    // A one-character string has no bigrams at all. Both sides empty is the
    // 0/0 that a naive ratio divides by, so it is pinned from both ends.
    { name: "one character against itself is 1", a: "a", b: "a", expected: 1 },
    { name: "one character against another is 0", a: "a", b: "b", expected: 0 },
    { name: "two empty strings are 1", a: "", b: "", expected: 1 },
    { name: "an empty string against text is 0", a: "", b: PLANTS, expected: 0 },
    { name: "one character against text is 0", a: "a", b: PLANTS, expected: 0 },
    // The threshold the resolver reads, from both sides of it.
    { name: "the threshold itself is 0.6", a: "abcdef", b: "abcdxy", expected: 0.6 },
    { name: "one bigram less is below the threshold", a: "abcdefg", b: "abcdxyz", expected: 0.5 },
    // Bigrams are a multiset: `aaaa` has three of `aa`, not one.
    { name: "a repeated bigram counts once per occurrence", a: "aaaa", b: "aa", expected: 0.5 },
  ];

  for (const { name, a, b, expected } of cases) {
    it(name, () => {
      expect(diceBigramSimilarity(a, b)).toBeCloseTo(expected, 12);
      expect(diceBigramSimilarity(b, a)).toBeCloseTo(expected, 12);
    });
  }

  it("never leaves the 0 to 1 range", () => {
    for (const [a, b] of [
      [PLANTS, PLANTS_TOMORROW],
      [PLANTS, ""],
      ["", ""],
      ["aaaa", "aaaa"],
    ]) {
      const value = diceBigramSimilarity(a, b);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("resolveAnchor", () => {
  it("1: same hash and same ordinal on the same line changes nothing", () => {
    const lines = parseTaskLines(["# Notes", task(PLANTS), task(CAT)].join("\n"));
    const anchor = anchorFor(PLANTS, 0, 1);

    const result = resolveAnchor(anchor, lines, NOTHING_CLAIMED);

    expect(result).not.toBeNull();
    expect(result?.index).toBe(0);
    // The same object back, because step 1 is the case where nothing moved.
    expect(result?.anchor).toBe(anchor);
  });

  it("2: same hash with a stale ordinal refreshes the ordinal", () => {
    const lines = parseTaskLines([task(PLANTS), task(CAT)].join("\n"));
    // The duplicate this anchor was the second of has been deleted.
    const anchor = anchorFor(PLANTS, 1, 0);

    const result = resolveAnchor(anchor, lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(0);
    expect(result?.anchor).toEqual(anchorFor(PLANTS, 0, 0));
  });

  it("3: same hash and ordinal ten lines down refreshes the line", () => {
    const markdown = [
      "# Notes",
      ...Array.from({ length: 10 }, (_, i) => `A paragraph ${i + 1}.`),
      task(PLANTS),
    ].join("\n");
    const lines = parseTaskLines(markdown);
    const anchor = anchorFor(PLANTS, 0, 1);

    const result = resolveAnchor(anchor, lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(0);
    expect(result?.anchor).toEqual(anchorFor(PLANTS, 0, 11));
    expect(result?.anchor.ordinal).toBe(0);
  });

  it("4: two identical lines and ordinal 0 binds the first", () => {
    const lines = parseTaskLines([task(PLANTS), task(PLANTS)].join("\n"));

    const result = resolveAnchor(anchorFor(PLANTS, 0, 0), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(0);
    expect(result?.anchor.line).toBe(0);
  });

  it("5: two identical lines and ordinal 1 binds the second", () => {
    const lines = parseTaskLines([task(PLANTS), task(PLANTS)].join("\n"));

    const result = resolveAnchor(anchorFor(PLANTS, 1, 0), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(1);
    expect(result?.anchor).toEqual(anchorFor(PLANTS, 1, 1));
  });

  it("6: an absent hash and similar text rebinds and refreshes every field", () => {
    const lines = parseTaskLines(task(PLANTS_TODAY));
    const anchor = anchorFor(PLANTS, 0, 0);

    const result = resolveAnchor(anchor, lines, NOTHING_CLAIMED);

    expect(diceBigramSimilarity(PLANTS, PLANTS_TODAY)).toBeGreaterThanOrEqual(0.6);
    expect(result?.index).toBe(0);
    expect(result?.anchor).toEqual(anchorFor(PLANTS_TODAY, 0, 0));
  });

  it("7: an absent hash and unlike text detaches", () => {
    const lines = parseTaskLines(task(CAT));

    expect(diceBigramSimilarity(PLANTS, CAT)).toBeLessThan(0.6);
    expect(resolveAnchor(anchorFor(PLANTS, 0, 0), lines, NOTHING_CLAIMED)).toBeNull();
  });

  it("8: a claimed nearer candidate is passed over for an unclaimed farther one", () => {
    const lines = parseTaskLines(
      [task(PLANTS_TODAY), task(CAT), task(PLANTS_TOMORROW)].join("\n"),
    );

    const result = resolveAnchor(anchorFor(PLANTS, 0, 0), lines, new Set([0]));

    expect(result?.index).toBe(2);
    expect(result?.anchor).toEqual(anchorFor(PLANTS_TOMORROW, 0, 2));
  });

  it("9: the only candidate, already claimed, is never stolen", () => {
    const lines = parseTaskLines(task(PLANTS_TODAY));

    expect(resolveAnchor(anchorFor(PLANTS, 0, 0), lines, new Set([0]))).toBeNull();
  });

  it("10: two unclaimed candidates bind the one nearest the remembered line", () => {
    const lines = parseTaskLines(
      [task(PLANTS_TODAY), task(CAT), task(PLANTS_TOMORROW)].join("\n"),
    );

    const result = resolveAnchor(anchorFor(PLANTS, 0, 3), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(2);
    expect(result?.anchor).toEqual(anchorFor(PLANTS_TOMORROW, 0, 2));
  });

  it("11: an empty page detaches", () => {
    expect(resolveAnchor(anchorFor(PLANTS, 0, 0), parseTaskLines(""), NOTHING_CLAIMED)).toBeNull();
  });

  it("12: a page with no task lines detaches", () => {
    const lines = parseTaskLines("# Notes\n\nA paragraph about the plants.\n");

    expect(lines).toEqual([]);
    expect(resolveAnchor(anchorFor(PLANTS, 0, 0), lines, NOTHING_CLAIMED)).toBeNull();
  });

  it("13: step 2 wins over a nearer step 3 candidate", () => {
    // The similar line sits on the remembered line itself and the exact one
    // is five lines away. A resolver written as a score would take the near
    // one. The cascade takes the hash.
    const markdown = [
      task(PLANTS_TODAY),
      "A paragraph.",
      "A paragraph.",
      "A paragraph.",
      "A paragraph.",
      task(PLANTS),
    ].join("\n");
    const lines = parseTaskLines(markdown);

    const result = resolveAnchor(anchorFor(PLANTS, 0, 0), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(1);
    expect(result?.anchor).toEqual(anchorFor(PLANTS, 0, 5));
  });

  // Cases 14 to 16 are the threshold itself, at the resolver and not at the
  // coefficient. `diceBigramSimilarity`'s own table asserts the number 0.6.
  // These three assert the decision the resolver makes at that number, which
  // is what the 0.6 rule actually is. Without them the threshold can be moved
  // anywhere between 0.385 and 0.769 and nothing notices.

  it("14: a candidate at exactly 0.600 binds, because the threshold is inclusive", () => {
    const lines = parseTaskLines(task(RENT_NOON));

    expect(diceBigramSimilarity(RENT_TODAY, RENT_NOON)).toBe(0.6);
    const result = resolveAnchor(anchorFor(RENT_TODAY, 0, 0), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(0);
    expect(result?.anchor).toEqual(anchorFor(RENT_NOON, 0, 0));
  });

  it("15: a candidate at 0.611, a shade over the threshold, binds", () => {
    const lines = parseTaskLines(task(RENT_BILLS));

    const similarity = diceBigramSimilarity(RENT, RENT_BILLS);
    expect(similarity).toBeGreaterThan(0.6);
    expect(similarity).toBeLessThan(0.62);
    expect(resolveAnchor(anchorFor(RENT, 0, 0), lines, NOTHING_CLAIMED)?.index).toBe(0);
  });

  it("16: a candidate at 0.596, a shade under the threshold, detaches", () => {
    const lines = parseTaskLines(task(REPORT_KEY));

    const similarity = diceBigramSimilarity(REPORT_NOON, REPORT_KEY);
    expect(similarity).toBeLessThan(0.6);
    expect(similarity).toBeGreaterThan(0.58);
    expect(resolveAnchor(anchorFor(REPORT_NOON, 0, 0), lines, NOTHING_CLAIMED)).toBeNull();
  });

  it("17: two equally distant rebind candidates bind the earlier line", () => {
    // Both are over the threshold and both are one line from the remembered
    // line, so only the tie-break decides. It has to be the same answer every
    // time, or an anchor flips between two lines on successive reconciles.
    const lines = parseTaskLines(
      [task(PLANTS_TODAY), "A paragraph.", task(PLANTS_TOMORROW)].join("\n"),
    );

    const result = resolveAnchor(anchorFor(PLANTS, 0, 1), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(0);
    expect(result?.anchor).toEqual(anchorFor(PLANTS_TODAY, 0, 0));
  });

  it("18: same-hash lines with no matching ordinal bind the nearest", () => {
    // Three copies of one text and an ordinal none of them carries, which is
    // the state after duplicates above a task are deleted. Step 2 falls back
    // to distance, and the remembered line is the last copy.
    const markdown = [
      task(PLANTS),
      "A paragraph.",
      task(PLANTS),
      "A paragraph.",
      task(PLANTS),
    ].join("\n");
    const lines = parseTaskLines(markdown);

    const result = resolveAnchor(anchorFor(PLANTS, 9, 4), lines, NOTHING_CLAIMED);

    expect(result?.index).toBe(2);
    expect(result?.anchor).toEqual(anchorFor(PLANTS, 2, 4));
  });

  it("never hands two anchors the same line", () => {
    const lines = parseTaskLines([task(PLANTS), task(PLANTS)].join("\n"));
    const claimed = new Set<number>();

    for (const ordinal of [0, 1, 0]) {
      const result = resolveAnchor(anchorFor(PLANTS, ordinal, 0), lines, claimed);
      if (result) {
        expect(claimed.has(result.index)).toBe(false);
        claimed.add(result.index);
      }
    }

    expect([...claimed].sort()).toEqual([0, 1]);
  });

  it("reads no clock, in every export of anchor.ts", () => {
    const lines = parseTaskLines([task(PLANTS), task(CAT)].join("\n"));
    const exercised: Record<string, () => unknown> = {
      // Both branches: the `a === b` short circuit answers before any
      // counting, so a clock read on that line hides from the unequal call.
      diceBigramSimilarity: () => [
        diceBigramSimilarity(PLANTS, CAT),
        diceBigramSimilarity(PLANTS, PLANTS),
      ],
      resolveAnchor: () => [
        resolveAnchor(anchorFor(PLANTS, 0, 0), lines, NOTHING_CLAIMED),
        resolveAnchor(anchorFor(PLANTS, 3, 9), lines, NOTHING_CLAIMED),
        resolveAnchor(anchorFor(PLANTS_TODAY, 0, 0), lines, NOTHING_CLAIMED),
        resolveAnchor(anchorFor(PLANTS, 0, 0), lines, new Set([0])),
      ],
    };

    // A new export has to be added above, or this fails before the trap runs.
    const callable = Object.entries(anchorModule)
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
