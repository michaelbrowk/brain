import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("the AI chip's CSS", () => {
  it("is the Label register, the muted ink and the glass hover fill", () => {
    const rule = block(".ai-chip");
    expect(rule).toContain("font-size: 11px");
    expect(rule).toContain("font-weight: 600");
    expect(rule).toContain("color: var(--ink-3)");
    expect(rule).toContain("background-color: var(--fill-glass-hover)");
    expect(rule).toContain("border-radius: 4px");
  });

  it("writes no colour of its own", () => {
    const rule = block(".ai-chip");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rule).not.toMatch(/\b(rgb|rgba|hsl|oklch)\(/);
  });
});
