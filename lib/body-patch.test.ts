import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyBodyPatch,
  bodyHash,
  diffBodyPatch,
  parseBodyPatches,
} from "./body-patch";

const nodeSha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("bodyHash", () => {
  it("is SHA-256 over UTF-8, the same digest the server's crypto gives", () => {
    const samples = [
      "",
      "a",
      "abc",
      "The quick brown fox jumps over the lazy dog",
      // 55, 56 and 64 bytes sit on the padding boundaries of one block.
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "Привет, мир — ✓ 🧠 \u{1F600}",
      // A lone surrogate encodes as U+FFFD in both TextEncoder and Buffer.
      "broken \uD83D pair",
      "# Heading\n\n- [ ] task\n".repeat(7_000),
    ];
    for (const sample of samples) {
      expect(bodyHash(sample)).toBe(nodeSha256(sample));
    }
  });
});

describe("diffBodyPatch / applyBodyPatch", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["", "new"],
    ["old", ""],
    ["same", "same"],
    ["Hello world", "Hello brave world"],
    ["abcabc", "abc"],
    ["aaa", "aaaa"],
    ["start middle end", "start end"],
    ["emoji 🧠 here", "emoji 🧪 here"],
    ["\u{1F600}", "\u{1F601}"],
  ];

  it("reproduces the newer body exactly from the older one", () => {
    for (const [from, to] of cases) {
      const patch = diffBodyPatch(from, to);
      expect(applyBodyPatch(from, patch)).toBe(to);
    }
  });

  it("sends only the changed span of a large body", () => {
    const from = `${"Paragraph of an old, long page.\n\n".repeat(4_000)}Last line`;
    const to = `${from} and a few words typed before closing`;
    const patch = diffBodyPatch(from, to);
    expect(patch).toEqual({
      at: from.length,
      del: 0,
      ins: " and a few words typed before closing",
    });
  });

  it("refuses a span that does not fit the body it is applied to", () => {
    expect(applyBodyPatch("short", { at: 3, del: 9, ins: "" })).toBeNull();
    expect(applyBodyPatch("short", { at: 9, del: 0, ins: "x" })).toBeNull();
  });
});

describe("parseBodyPatches", () => {
  const base = bodyHash("body");

  it("accepts one to eight well-formed patches", () => {
    expect(parseBodyPatches([{ base, at: 0, del: 1, ins: "B" }])).toEqual([
      { base, at: 0, del: 1, ins: "B" },
    ]);
  });

  it("rejects anything else", () => {
    for (const value of [
      undefined,
      null,
      "x",
      [],
      [{ base: "nothex", at: 0, del: 0, ins: "" }],
      [{ base, at: -1, del: 0, ins: "" }],
      [{ base, at: 0.5, del: 0, ins: "" }],
      [{ base, at: 0, del: 0, ins: 3 }],
      Array.from({ length: 9 }, () => ({ base, at: 0, del: 0, ins: "" })),
    ]) {
      expect(parseBodyPatches(value)).toBeNull();
    }
  });
});
