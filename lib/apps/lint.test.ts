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

/** HTML does not require quotes and never did, and the review found six
 *  shapes of external reference the first regex let through. Every row is one
 *  of them. */
describe("the external-resource rule reads an attribute the way a browser does", () => {
  const body = (markup: string) =>
    ['<meta name="color-scheme" content="light dark">', markup].join("\n");

  it.each([
    ["an unquoted src", "<script src=https://cdn.x/a.js></script>"],
    ["a single-quoted src", "<script src='https://cdn.x/a.js'></script>"],
    ["an unquoted img src", "<img src=https://x/y.png>"],
    ["a srcset", '<img srcset="https://x/y.png 2x">'],
    ["an unquoted srcset", "<img srcset=https://x/y.png>"],
    ["an object data", '<object data="https://x/a.pdf">'],
    ["a video poster", '<video poster="https://x/p.jpg">'],
    ["a form action", '<form action="https://x/post">'],
    ["a button formaction", '<button formaction="https://x/post">'],
    ["a ping", '<a ping="https://x/track" href="#top">go</a>'],
    ["a body background", '<body background="https://x/b.png">'],
    ["a protocol-relative src", '<img src="//x/y.png">'],
    ["an absolute path, which reaches Brain and not the app", '<img src="/api/app/a/assets/y.png">'],
  ])("refuses %s", (_name, markup) => {
    expect(lintAppEntry(body(markup))?.rule).toBe("external_resource");
    expect(lintAppEntry(body(markup))?.line).toBe(2);
  });

  it.each([
    ["a relative src", '<img src="assets/card.png">'],
    ["an unquoted relative src", "<img src=assets/card.png>"],
    ["a srcset of its own assets", '<img srcset="assets/a.png 1x, assets/b.png 2x">'],
    ["a fragment href", '<a href="#top">top</a>'],
    ["a data URI holding a namespace that looks external", "<img src=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>\">"],
  ])("lets %s through", (_name, markup) => {
    expect(lintAppEntry(body(markup))).toBeNull();
  });

  it("catches an @import that carries no url(), which the url rule would miss", () => {
    const entry = [
      '<meta name="color-scheme" content="light dark">',
      "<style>",
      '@import "https://fonts.example/x.css";',
      "</style>",
    ].join("\n");
    expect(entry).not.toContain("url(");
    expect(lintAppEntry(entry)).toEqual({ rule: "external_resource", line: 3 });
  });

  it("skips the kit link itself without skipping what shares its line", () => {
    // The link has no reference to check and is the one the serve step
    // replaces, so it is blanked out. Blanking the whole LINE instead would
    // make it a place to hide a script behind.
    expect(lintAppEntry('<link rel="brain-kit">\n<p>hola</p>')).toBeNull();
    expect(
      lintAppEntry('<link rel="brain-kit"><script src="https://evil.x/a.js"></script>')?.rule,
    ).toBe("external_resource");
  });
});

describe("a comment hides nothing from the lint", () => {
  it("does not read a commented-out declaration as one", () => {
    expect(lintAppEntry('<!-- <meta name="color-scheme" content="light dark"> -->\n<p>x</p>')).toEqual(
      { rule: "color_scheme", line: 1 },
    );
  });

  it("does not read a commented-out kit link as the kit", () => {
    expect(lintAppEntry('<!-- <link rel="brain-kit"> -->\n<p>x</p>')).toEqual({
      rule: "color_scheme",
      line: 1,
    });
  });

  it("still sees what follows a commented-out kit link on the same line", () => {
    const entry = [
      '<meta name="color-scheme" content="light dark">',
      '<!-- <link rel="brain-kit"> --><script src="https://evil.x/a.js"></script>',
    ].join("\n");
    expect(lintAppEntry(entry)).toEqual({ rule: "external_resource", line: 2 });
  });

  it("keeps the line numbers a comment spans", () => {
    const entry = [
      '<meta name="color-scheme" content="light dark">',
      "<!-- one",
      "two -->",
      "<style>a { color: #fff }</style>",
    ].join("\n");
    expect(lintAppEntry(entry)).toEqual({ rule: "hard_coded_colour", line: 4 });
  });
});

describe("a # that is not a colour", () => {
  const body = (markup: string) =>
    ['<meta name="color-scheme" content="light dark">', markup].join("\n");

  it.each([
    ["a fragment href that spells one", '<a href="#dead">x</a>'],
    ["a three-letter fragment", '<a href="#add">x</a>'],
    ["an unquoted fragment", "<a href=#beef>x</a>"],
    ["an SVG paint reference", "<style>.a { fill: url(#face) }</style>"],
    ["a querySelector", '<script>document.querySelector("#abc");</script>'],
    ["a querySelectorAll", "<script>document.querySelectorAll('#cafe .row');</script>"],
    ["a getElementById", '<script>document.getElementById("dad");</script>'],
    ["an element id", '<div id="beaded"></div>'],
    ["an aria reference written as a fragment", '<div aria-controls="#fed"></div>'],
  ])("lets %s through", (_name, markup) => {
    expect(lintAppEntry(body(markup))).toBeNull();
  });

  it("still refuses a hex in a string, because nothing can tell what it is for", () => {
    expect(lintAppEntry(body('<script>const c = "#abc";</script>'))?.rule).toBe(
      "hard_coded_colour",
    );
  });
});

describe("a named colour is a hard-coded colour where CSS reads one", () => {
  const body = (markup: string) =>
    ['<meta name="color-scheme" content="light dark">', markup].join("\n");

  it.each([
    ["a background in a style block", "<style>body { background: red }</style>"],
    ["a colour in a style block", "<style>.a { color: white }</style>"],
    ["one inside a shorthand", "<style>.a { border: 1px solid black }</style>"],
    ["one in a style attribute", '<div style="background: red"></div>'],
    ["one with an unusual name", "<style>.a { color: rebeccapurple }</style>"],
  ])("refuses %s", (_name, markup) => {
    expect(lintAppEntry(body(markup))).toEqual({ rule: "hard_coded_colour", line: 2 });
  });

  it.each([
    ["a word in prose", "<p>The apple is red</p>"],
    ["a class name", '<div class="red-team"></div>'],
    ["a string in a script", '<script>const team = "red";</script>'],
    ["a selector", "<style>.red { padding: 0 }</style>"],
    ["the keyword that is not a colour", "<style>.a { background: transparent }</style>"],
    ["the one that follows the text", "<style>.a { border-color: currentcolor }</style>"],
    ["a CSS-wide keyword", "<style>.a { color: inherit }</style>"],
    ["a colour inside a token fallback", "<style>.a { color: var(--ink, red) }</style>"],
    ["an asset whose name happens to be one", '<style>.a { background: url(assets/red.png) }</style>'],
  ])("lets %s through", (_name, markup) => {
    expect(lintAppEntry(body(markup))).toBeNull();
  });
});
