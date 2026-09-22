import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintAppEntry } from "@/lib/apps/lint";
import { APP_ENTRY_MAX_BYTES } from "@/lib/apps/model";

const dir = path.join(process.cwd(), "examples", "apps", "spanish-trainer");
const entry = readFileSync(path.join(dir, "index.html"), "utf8");
const vocabulary = readFileSync(path.join(dir, "vocabulary.js"), "utf8");

describe("the trainer's entry", () => {
  it("passes the lint that would refuse it at create_app_page", () => {
    expect(lintAppEntry(entry)).toBeNull();
  });

  it("is under the entry cap with room to spare", () => {
    expect(Buffer.byteLength(entry, "utf8")).toBeLessThan(APP_ENTRY_MAX_BYTES);
  });

  it("asks for the kit rather than shipping its own styles", () => {
    expect(entry).toContain('<link rel="brain-kit">');
  });

  it("leans on the kit for the colour scheme rather than repeating it", () => {
    // The kit's first rule is `:root { color-scheme: light dark }`, and the
    // lint accepts the kit link as the declaration for exactly this reason.
    // Repeating it here would be two places saying one thing.
    expect(entry).not.toContain('name="color-scheme"');
    expect(lintAppEntry(entry)).toBeNull();
  });

  it("carries the tested module verbatim, so the two cannot drift", () => {
    const body = vocabulary.replace(/^export /gm, "");
    expect(entry).toContain(body.trim());
  });

  it("offers the three answers the spec named", () => {
    for (const answer of ["Again", "Good", "Easy"]) {
      expect(entry).toContain(`>${answer}<`);
    }
  });

  it("writes only its own Words page", () => {
    expect(entry).toContain("writePage");
    // One write call site, and the id it names is the Words page's. Counting
    // the call sites is not enough: a trainer rewritten to write its own app
    // page, or any other id it is holding, still has exactly one of them, and
    // `owns` on the server would be the only thing left refusing it. The
    // target is the assertion.
    expect(entry.match(/brain\.writePage\(/g)).toHaveLength(1);
    expect(entry).toContain("brain.writePage(settings.wordsPageId,");
    expect(entry).not.toContain("brain.createPage(");
  });

  it("reads the tree and the pages under the chosen parent", () => {
    expect(entry).toContain("brain.readTree()");
    expect(entry).toContain("brain.readPage(");
  });

  it("keeps its settings in state rather than in the frame's storage", () => {
    expect(entry).toContain("brain.getState()");
    expect(entry).toContain("brain.setState(");
    expect(entry).not.toContain("localStorage");
  });

  it("calls nothing the kit does not define", () => {
    // The names are the kit's own (`lib/apps/kit.ts`), not a shape invented
    // here: an app that calls a method the kit never had fails silently in a
    // frame where an unhandled rejection reaches no console the owner opens.
    const called = new Set(
      [...entry.matchAll(/\bbrain\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
    );
    const defined = new Set([
      "ready",
      "readTree",
      "readPage",
      "readPages",
      "writePage",
      "createPage",
      "getState",
      "setState",
      "open",
      "toast",
      "on",
    ]);
    expect([...called].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("draws in the kit's own classes and adds no colour", () => {
    for (const name of ["text-title", "text-body", "text-caption", "btn", "card"]) {
      expect(entry).toContain(name);
    }
  });

  it("carries no em-dash in a string the user reads", () => {
    // Task 22's module matches `word — translation` as a separator, and that
    // regex is inlined into this file inside a <script>. A scan over ">…<"
    // would read the whole script body as visible text and fail on it, so the
    // two element bodies that are never prose come out first.
    const prose = entry
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    const visible = [...prose.matchAll(/>([^<>]+)</g)].map((match) => match[1]).join("");
    expect(visible).not.toContain("—");
    // and the guard is worth something: the script it skipped does carry one
    expect(entry).toContain("—");
  });
});
