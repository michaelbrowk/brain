import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { parsePage } from "./frontmatter";

type MatterWithCache = typeof matter & { cache: Record<string, unknown> };

describe("parsePage", () => {
  it("does not grow gray-matter's process-wide parse cache", () => {
    const cache = (matter as MatterWithCache).cache;
    for (const key of Object.keys(cache)) delete cache[key];

    for (let i = 0; i < 20; i += 1) {
      parsePage(`---\nid: page${i}\ntitle: Draft ${i}\n---\n\nBody ${i}\n`);
    }

    // gray-matter caches unconditionally (keyed by the whole input string)
    // when called without options. Every autosaved revision is a new string,
    // so that cache is an unbounded leak — parsePage must opt out of it.
    expect(Object.keys(cache)).toHaveLength(0);
  });
});
