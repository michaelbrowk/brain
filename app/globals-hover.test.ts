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

  it("leaves a palette row something to say when a finger presses it", () => {
    const press = all.filter((r) => /\.brain-palette-item:active/.test(r.selector));
    expect(press.length).toBeGreaterThan(0);
    expect(press.every((r) => !guarded(r))).toBe(true);
  });
});
