import { describe, expect, it } from "vitest";
import {
  cleanVisitorTitle,
  isShareExpired,
  normalizeVisitorName,
  normalizeVisitorTitle,
  parseShareExpiry,
} from "./sharing";

describe("share expiry", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");

  it("keeps an absent or future deadline active", () => {
    expect(isShareExpired(undefined, now)).toBe(false);
    expect(isShareExpired("2026-07-27T12:00:00.000Z", now)).toBe(false);
  });

  it("fails closed for elapsed and malformed deadlines", () => {
    expect(isShareExpired("2026-07-26T12:00:00.000Z", now)).toBe(true);
    expect(isShareExpired("not-a-date", now)).toBe(true);
  });

  it("accepts only a bounded future ISO timestamp or an explicit reset", () => {
    expect(parseShareExpiry(undefined, now)).toBeUndefined();
    expect(parseShareExpiry(null, now)).toBeNull();
    expect(parseShareExpiry("", now)).toBeNull();
    expect(parseShareExpiry("2026-08-02T12:00:00.000Z", now)).toBe(
      "2026-08-02T12:00:00.000Z",
    );
    expect(() => parseShareExpiry("2026-07-26T11:59:59.999Z", now)).toThrow();
    expect(() => parseShareExpiry("2028-07-26T12:00:00.000Z", now)).toThrow();
    expect(() => parseShareExpiry("2026-08-02", now)).toThrow();
  });
});

describe("normalizeVisitorName", () => {
  it("trims, strips control characters and truncates to 40", () => {
    expect(normalizeVisitorName("  Ada Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeVisitorName("Ada\u0000\u001bLovelace")).toBe("AdaLovelace");
    expect(normalizeVisitorName("a".repeat(60))).toBe("a".repeat(40));
  });

  it("refuses anything that is empty once cleaned", () => {
    expect(normalizeVisitorName("")).toBeNull();
    expect(normalizeVisitorName("   ")).toBeNull();
    expect(normalizeVisitorName("\u0000\u0007")).toBeNull();
    expect(normalizeVisitorName(42)).toBeNull();
    expect(normalizeVisitorName(undefined)).toBeNull();
  });

  // The name reaches the owner's Hub as a badge, so it takes the title's
  // policy: every format character goes, the two joiners stay. A name is
  // signed into a claim and written to frontmatter without a second pass, so
  // this function is where an override is stopped or not at all.
  it("strips format characters that reorder or hide text, and keeps the joiners", () => {
    const rlo = String.fromCodePoint(0x202e);
    const isolate = String.fromCodePoint(0x2067);
    const bom = String.fromCodePoint(0xfeff);
    const zwsp = String.fromCodePoint(0x200b);
    const zwj = String.fromCodePoint(0x200d);
    const zwnj = String.fromCodePoint(0x200c);
    expect(normalizeVisitorName(`${bom}Ada${rlo}Lovelace`)).toBe("AdaLovelace");
    expect(normalizeVisitorName(`A${isolate}d${zwsp}a`)).toBe("Ada");
    expect(normalizeVisitorName(`Ada${zwj}${zwnj}L`)).toBe(`Ada${zwj}${zwnj}L`);
    // C1 too, not only the C0 range and DEL
    expect(normalizeVisitorName("Ada\u0085Lovelace")).toBe("AdaLovelace");
    expect(normalizeVisitorName(rlo)).toBeNull();
  });
});

describe("normalizeVisitorTitle", () => {
  it("trims, strips control characters and cuts to 200 code points", () => {
    expect(normalizeVisitorTitle("  Meeting notes  ")).toBe("Meeting notes");
    expect(normalizeVisitorTitle("Notes \nfrom\u0000Ada")).toBe("Notes fromAda");
    expect(normalizeVisitorTitle("a".repeat(250))).toBe("a".repeat(200));
    // The cut counts code points, so it never leaves half a surrogate pair.
    expect(normalizeVisitorTitle("\u{1F600}".repeat(201))).toBe(
      "\u{1F600}".repeat(200),
    );
    expect(normalizeVisitorTitle(`${"a".repeat(199)} b`)).toBe("a".repeat(199));
  });

  it("strips format characters that reorder or hide text, and keeps the joiners", () => {
    const rlo = String.fromCodePoint(0x202e);
    const isolate = String.fromCodePoint(0x2067);
    const bom = String.fromCodePoint(0xfeff);
    const zwsp = String.fromCodePoint(0x200b);
    expect(normalizeVisitorTitle(`${bom}Invoice${rlo}fdp.exe`)).toBe(
      "Invoicefdp.exe",
    );
    expect(normalizeVisitorTitle(`a${isolate}b${zwsp}c`)).toBe("abc");
    // ZWJ builds emoji sequences and ZWNJ shapes Persian and Arabic words.
    // Neither reorders text, so a title keeps them.
    const zwj = String.fromCodePoint(0x200d);
    const zwnj = String.fromCodePoint(0x200c);
    const family = `\u{1F468}${zwj}\u{1F469}${zwj}\u{1F467}`;
    expect(normalizeVisitorTitle(family)).toBe(family);
    const persian = `\u{0645}\u{06CC}${zwnj}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}`;
    expect(normalizeVisitorTitle(persian)).toBe(persian);
  });

  it("falls back to Untitled once cleaned to nothing and refuses a non-string", () => {
    expect(normalizeVisitorTitle("")).toBe("Untitled");
    expect(normalizeVisitorTitle("   ")).toBe("Untitled");
    expect(normalizeVisitorTitle("\u0000\u0007")).toBe("Untitled");
    expect(normalizeVisitorTitle(42)).toBeNull();
    expect(normalizeVisitorTitle(["x"])).toBeNull();
    expect(normalizeVisitorTitle(undefined)).toBeNull();
  });
});

describe("cleanVisitorTitle", () => {
  it("cleans by the same rule and returns what is left, with no fallback", () => {
    expect(cleanVisitorTitle("  Meeting notes  ")).toBe("Meeting notes");
    expect(cleanVisitorTitle("Notes \nfrom\u0000Ada")).toBe("Notes fromAda");
    expect(cleanVisitorTitle("a".repeat(250))).toBe("a".repeat(200));
  });

  it("is empty exactly where the route would answer Untitled", () => {
    for (const value of ["", "   ", "\u0000\u0007"]) {
      expect(cleanVisitorTitle(value)).toBe("");
      expect(normalizeVisitorTitle(value)).toBe("Untitled");
    }
    expect(cleanVisitorTitle(42)).toBe("");
    expect(cleanVisitorTitle(undefined)).toBe("");
  });

  it("keeps a title the visitor typed as Untitled, because they chose it", () => {
    expect(cleanVisitorTitle("Untitled")).toBe("Untitled");
  });
});
