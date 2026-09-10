import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** DESIGN.md §8: hover is a pointer state. A touch screen has no pointer, so
 *  a `:hover` rule it can reach paints on the tap and stays painted until
 *  something else takes it away — which reads as a selection that will not
 *  clear. These are static checks on the one stylesheet the app ships, so
 *  they can see which rules paint and under what condition, and nothing
 *  about what the browser then does with them. */

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; at: string[] };

/** Every style rule with the at-rules it sits inside. Hand-written CSS with
 *  balanced braces and terminated declarations, which is what this file is. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push(head.trim().replace(/\s+/g, " "));
      head = "";
    } else if (ch === "}") {
      const closed = stack.pop() ?? "";
      if (closed && !closed.startsWith("@")) out.push({ selector: closed, at: stack.filter((s) => s.startsWith("@")) });
      head = "";
    } else if (ch === ";") {
      head = "";
    } else {
      head += ch;
    }
  }
  return out;
}

const all = rules(css);
const guarded = (r: Rule) => r.at.some((a) => /^@media \(hover: hover\)$/.test(a));

describe("hover and the pointer that is not there", () => {
  it("gives the palette's cursor plate a pointer or a keyboard to belong to", () => {
    const plate = all.filter((r) => r.selector.includes('.brain-palette-item[data-selected="true"]'));
    expect(plate.length).toBeGreaterThan(0);
    for (const r of plate) {
      const real = guarded(r) || r.selector.includes("html[data-kbd]");
      expect(real, `the palette cursor plate paints with no pointer and no keyboard: ${r.selector}`).toBe(true);
    }
    // both halves survive: a mouse moves the plate, a keyboard moves the plate
    expect(plate.some(guarded)).toBe(true);
    expect(plate.some((r) => r.selector.includes("html[data-kbd]"))).toBe(true);
  });

  it("keeps every :hover rule behind a pointer that can hover", () => {
    const hovers = all.filter((r) => r.selector.includes(":hover"));
    // the file is full of them, so a parser that quietly found none would pass
    expect(hovers.length).toBeGreaterThan(30);
    for (const r of hovers) {
      expect(guarded(r), `a touch screen can reach this hover and will not let go of it: ${r.selector}`).toBe(true);
    }
  });

  it("keeps the states that are not hover out of the guard", () => {
    // a keyboard, a Radix highlight and an open menu are not a pointer, and
    // a blanket wrap over a shared selector list would have taken them too
    const survivors = [
      ".brain-focus-exit:focus-visible",
      ".tree-row:focus-within .tree-row-more",
      '.tree-row-more:has([data-state="open"])',
      ".brain-menu-item[data-highlighted]",
      ".brain-menu-item[data-highlighted] .brain-menu-icon",
      ".tree-row[data-selected] .tree-row-glyph",
    ];
    for (const s of survivors) {
      const owners = all.filter((r) => r.selector.split(",").some((one) => one.trim() === s));
      expect(owners.length, `no rule paints ${s} any more`).toBeGreaterThan(0);
      expect(owners.every((r) => !guarded(r)), `${s} was swept into the hover guard`).toBe(true);
    }
  });

  it("answers a tap on every row whose only paint was the hover", () => {
    // these row families lost their tint on touch and none of them carries a
    // press scale to fall back on, so each has to answer a finger itself
    const rows = [".tree-row", ".brain-menu-item", ".brain-dialog-row"];
    for (const row of rows) {
      const press = all.filter((r) => new RegExp(`\\${row}(?![\\w-])[^,{]*:active`).test(r.selector));
      expect(press.length, `${row} has no press state`).toBeGreaterThan(0);
      expect(press.every((r) => !guarded(r)), `${row}'s press needs a pointer to paint`).toBe(true);
    }
  });

  it("answers a finger on the two share-card controls that only painted on hover", () => {
    // Both of these navigate rather than toggle, which was the argument for
    // leaving them alone, and neither navigation is instant: the address
    // opens a second tab, the eye repaints the field it sits in. DESIGN.md
    // §8 makes press one of five states and none of them is optional, so a
    // control that shows nothing while a finger is on it is unfinished.
    const pressOf = (selector: string) =>
      all.filter((r) =>
        r.selector.split(",").some((one) => one.trim() === `${selector}:active`),
      );
    for (const control of ["a.brain-share-url", ".brain-share-eye"]) {
      const press = pressOf(control);
      expect(press.length, `${control} has no press state`).toBeGreaterThan(0);
      expect(
        press.every((r) => !guarded(r)),
        `${control}'s press needs a pointer to paint`,
      ).toBe(true);
    }
    // the eye presses with a scale, so reduced motion has to be able to drop
    // it and keep the colour, the way it does for every other pressed icon
    const dropped = all.filter(
      (r) =>
        r.selector.split(",").some((one) => one.trim() === ".brain-share-eye:active") &&
        r.at.some((a) => a.includes("prefers-reduced-motion")),
    );
    expect(dropped.length, "a reduced-motion press keeps the eye's scale").toBe(1);
  });

  it("leaves a palette row something to say when a finger presses it", () => {
    const press = all.filter((r) => /\.brain-palette-item:active/.test(r.selector));
    expect(press.length).toBeGreaterThan(0);
    expect(press.every((r) => !guarded(r))).toBe(true);
  });
});
