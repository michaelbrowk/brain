import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  hashTaskText,
  normalizeTaskText,
  parseTaskLines,
  type TaskLine,
} from "./task-lines";

type Expectation = Partial<Omit<TaskLine, "hash">>;

const table: { name: string; markdown: string; lines: Expectation[] }[] = [
  {
    name: "a dash bullet is a task line",
    markdown: "- [ ] alpha",
    lines: [{ index: 0, checked: false, text: "alpha", normalized: "alpha", ordinal: 0 }],
  },
  {
    name: "a star bullet parses",
    markdown: "* [ ] alpha",
    lines: [{ index: 0, checked: false, text: "alpha" }],
  },
  {
    name: "a plus bullet parses",
    markdown: "+ [ ] alpha",
    lines: [{ index: 0, checked: false, text: "alpha" }],
  },
  {
    name: "a lowercase x is checked",
    markdown: "- [x] alpha",
    lines: [{ index: 0, checked: true, text: "alpha" }],
  },
  {
    name: "a capital X is checked",
    markdown: "- [X] alpha",
    lines: [{ index: 0, checked: true, text: "alpha" }],
  },
  {
    name: "a nested child is its own line",
    markdown: "- [ ] parent\n  - [x] child",
    lines: [
      { index: 0, checked: false, text: "parent" },
      { index: 1, checked: true, text: "child" },
    ],
  },
  {
    name: "the template's empty line is still a task line",
    markdown: "- [ ] <br />",
    lines: [{ index: 0, checked: false, text: "", normalized: "" }],
  },
  {
    name: "Notion's double space after the bullet parses",
    markdown: "-  [x] alpha",
    lines: [{ index: 0, checked: true, text: "alpha" }],
  },
  {
    name: "a fenced code block holding a bracket pair yields nothing",
    markdown: "```\n- [ ] alpha\n```",
    lines: [],
  },
  {
    name: "a tilde fence holding a bracket pair yields nothing",
    markdown: "~~~\n- [ ] alpha\n~~~",
    lines: [],
  },
  {
    name: "a fence closed by a longer run still ends",
    markdown: "````js\n- [ ] inside\n````\n- [ ] outside",
    lines: [{ index: 3, checked: false, text: "outside" }],
  },
  {
    name: "trailing whitespace is trimmed out of normalized",
    markdown: "- [ ] alpha   ",
    lines: [{ index: 0, normalized: "alpha" }],
  },
  {
    name: "CRLF leaves no carriage return in the text",
    markdown: "- [ ] alpha\r\n- [x] beta",
    lines: [
      { index: 0, checked: false, text: "alpha" },
      { index: 1, checked: true, text: "beta" },
    ],
  },
  {
    name: "a bare bullet is not a task line",
    markdown: "- alpha",
    lines: [],
  },
  {
    name: "two identical lines get ordinals 0 and 1",
    markdown: "- [ ] same\n- [ ] same",
    lines: [
      { index: 0, ordinal: 0, normalized: "same" },
      { index: 1, ordinal: 1, normalized: "same" },
    ],
  },
  {
    name: "an empty document yields nothing and does not throw",
    markdown: "",
    lines: [],
  },
  {
    name: "index is the line in the document, not the count of task lines",
    markdown: "# Title\n\n- [ ] alpha",
    lines: [{ index: 2, text: "alpha" }],
  },
];

describe("parseTaskLines", () => {
  it.each(table)("$name", ({ markdown, lines }) => {
    const parsed = parseTaskLines(markdown);
    expect(parsed).toHaveLength(lines.length);
    for (const [at, expected] of lines.entries()) {
      expect(parsed[at]).toMatchObject(expected);
    }
  });

  it("gives two lines that differ only in whitespace the same hash", () => {
    const [wide] = parseTaskLines("- [ ] a  b");
    const [narrow] = parseTaskLines("- [ ] a b");
    expect(wide.normalized).toBe("a b");
    expect(narrow.normalized).toBe("a b");
    expect(wide.hash).toBe(narrow.hash);
  });

  it("gives every line a 16 character lowercase hex hash", () => {
    for (const line of parseTaskLines("- [ ] alpha\n- [x] beta")) {
      expect(line.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("normalizeTaskText", () => {
  it.each([
    ["  alpha  ", "alpha"],
    ["a  b", "a b"],
    ["a\tb", "a b"],
    ["<br />", ""],
    ["<br/>", ""],
    ["<br>", ""],
    ["a <br /> b", "a b"],
    ["", ""],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeTaskText(raw)).toBe(expected);
  });
});

describe("hashTaskText", () => {
  it.each(["", "alpha", "a b", "Полить растения", "🌱 water", "x".repeat(500)])(
    "matches the first 16 hex of sha1 for %j",
    (text) => {
      const expected = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
      expect(hashTaskText(text)).toBe(expected);
    },
  );

  it("hashes a 56 and a 64 byte input, the block boundary sha1 pads around", () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120]) {
      const text = "a".repeat(length);
      const expected = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
      expect(hashTaskText(text)).toBe(expected);
    }
  });
});
