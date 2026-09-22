import { describe, expect, it } from "vitest";
import { lintAppEntry } from "./lint";

const ok = [
  "<!doctype html>",
  '<meta name="color-scheme" content="light dark">',
  "<style>",
  "  body { background: var(--paper); color: var(--ink); }",
  "  .card { border-radius: var(--r-md); box-shadow: none; }",
  "</style>",
  '<link rel="brain-kit">',
  '<div class="card">hola</div>',
  "<script>const answer = 1;</script>",
].join("\n");

describe("the app entry lint", () => {
  it("passes an entry that declares the scheme and reads the tokens", () => {
    expect(lintAppEntry(ok)).toBeNull();
  });

  it("accepts a CSS declaration as the scheme rather than a meta tag", () => {
    const css = ok.replace(
      '<meta name="color-scheme" content="light dark">',
      "<style>:root { color-scheme: light dark; }</style>",
    );
    expect(lintAppEntry(css)).toBeNull();
  });

  it("refuses an entry that declares no colour scheme and asks for no kit", () => {
    const without = ok
      .replace('<meta name="color-scheme" content="light dark">', "")
      .replace('<link rel="brain-kit">', "");
    expect(lintAppEntry(without)).toEqual({ rule: "color_scheme", line: 1 });
  });

  it("accepts the kit link as the declaration, because the kit declares it", () => {
    // The kit's first rule is `:root { color-scheme: light dark }`, injected
    // at serve time. An entry that asks for the kit and does not repeat the
    // declaration is correct, and refusing it would make the kit's own
    // example fail the lint that guards it.
    const kitOnly = ok.replace('<meta name="color-scheme" content="light dark">', "");
    expect(kitOnly).toContain('<link rel="brain-kit">');
    expect(lintAppEntry(kitOnly)).toBeNull();
  });

  it("refuses a hard-coded hex and names its line", () => {
    const hex = ok.replace("background: var(--paper)", "background: #fcfbf8");
    expect(lintAppEntry(hex)).toEqual({ rule: "hard_coded_colour", line: 4 });
  });

  it("refuses every colour function, not only hex", () => {
    for (const colour of ["rgb(1,2,3)", "rgba(1,2,3,.5)", "hsl(1 2% 3%)", "oklch(.9 0 0)"]) {
      const bad = ok.replace("var(--paper)", colour);
      expect(lintAppEntry(bad)?.rule).toBe("hard_coded_colour");
    }
  });

  it("lets a colour inside a var() fallback through, because that is the token path", () => {
    expect(lintAppEntry(ok.replace("var(--paper)", "var(--paper, canvas)"))).toBeNull();
  });

  it("strips a nested var() whole, and still sees a colour outside one", () => {
    // `var(--a, var(--b, x))` is the ordinary shape of a token with a token
    // fallback. A regex that stops at the first `)` leaves `)` behind and
    // reads the rest of the line as bare CSS.
    expect(
      lintAppEntry(ok.replace("var(--paper)", "var(--paper, var(--surface, canvas))")),
    ).toBeNull();
    expect(lintAppEntry(ok.replace("var(--paper)", "var(--paper, var(--surface))"))).toBeNull();
    // and a hex beside a nested var on the same line is still caught
    expect(
      lintAppEntry(
        ok.replace(
          "background: var(--paper); color: var(--ink);",
          "background: var(--a, var(--b)); color: #fff;",
        ),
      )?.rule,
    ).toBe("hard_coded_colour");
  });

  it("refuses an import and an external resource", () => {
    expect(
      lintAppEntry(ok.replace("<style>", "<style>@import url('https://fonts.example/x.css');"))
        ?.rule,
    ).toBe("external_resource");
    expect(
      lintAppEntry(
        ok.replace('<link rel="brain-kit">', '<script src="https://cdn.example/x.js"></script>'),
      )?.rule,
    ).toBe("external_resource");
    expect(lintAppEntry(ok.replace("hola", '<img src="https://img.example/a.png">'))?.rule).toBe(
      "external_resource",
    );
    expect(lintAppEntry(ok.replace("var(--paper)", "url(https://img.example/a.png)"))?.rule).toBe(
      "external_resource",
    );
  });

  it("lets an app's own assets and a data URI through", () => {
    expect(lintAppEntry(ok.replace("hola", '<img src="assets/card.png">'))).toBeNull();
    expect(lintAppEntry(ok.replace("hola", '<img src="data:image/png;base64,AA">'))).toBeNull();
  });

  it("names the first offending line when there are several", () => {
    const two = [
      "<!doctype html>",
      '<meta name="color-scheme" content="light dark">',
      "<style>",
      "a { color: #fff }",
      "b { color: #000 }",
      "</style>",
    ].join("\n");
    expect(lintAppEntry(two)).toEqual({ rule: "hard_coded_colour", line: 4 });
  });
});
