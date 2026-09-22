import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ASSETS_MAX_BYTES,
  APP_ENTRY_MAX_BYTES,
  APP_STATE_MAX_BYTES,
} from "@/lib/apps/model";
import { APP_KIT_CSS, APP_KIT_JS } from "@/lib/apps/kit";
import { lintAppEntry } from "@/lib/apps/lint";

const apps = readFileSync(path.join(process.cwd(), "docs", "apps.md"), "utf8");
const mcp = readFileSync(path.join(process.cwd(), "docs", "mcp-tools.md"), "utf8");

describe("docs/apps.md", () => {
  it("states the last-resort rule", () => {
    expect(apps).toContain("last resort");
    expect(apps).toContain("cannot be done with the notebook's own means");
  });

  it("states the three caps in the units the reader thinks in", () => {
    expect(APP_ENTRY_MAX_BYTES / 1024 / 1024).toBe(2);
    expect(APP_ASSETS_MAX_BYTES / 1024 / 1024).toBe(10);
    expect(APP_STATE_MAX_BYTES / 1024).toBe(256);
    expect(apps).toContain("2 MiB");
    expect(apps).toContain("10 MiB");
    expect(apps).toContain("256 KiB");
  });

  it("documents every bridge request", () => {
    for (const request of [
      "hello",
      "read.tree",
      "read.page",
      "read.pages",
      "write.page",
      "create.page",
      "state.get",
      "state.set",
      "open",
      "toast",
    ]) {
      expect(apps).toContain(request);
    }
  });

  it("documents every class the kit defines", () => {
    for (const name of [
      ".text-title",
      ".text-body",
      ".text-caption",
      ".text-label",
      ".btn",
      ".field",
      ".chip",
      ".card",
      ".row",
    ]) {
      expect(APP_KIT_CSS).toContain(name);
      expect(apps).toContain(name);
    }
  });

  it("says the app reaches no network", () => {
    expect(apps).toContain("connect-src 'none'");
  });

  it("says an asset is addressed relatively, because the policy names that folder", () => {
    // An agent that writes `/api/app/<id>/assets/x.png` or an absolute URL
    // gets a blocked request and no message. The doc says `assets/x.png`.
    expect(apps).toContain("assets/");
    expect(apps).toContain("img-src");
  });

  it("states the design rules the spec named", () => {
    for (const rule of ["monochrome", "one accent", "no dashboards", "never hard-code"]) {
      expect(apps.toLowerCase()).toContain(rule.toLowerCase());
    }
  });

  it("names the three lint rules and what each one means", () => {
    for (const rule of ["color_scheme", "hard_coded_colour", "external_resource"]) {
      expect(apps).toContain(rule);
    }
  });

  it("states the two narrowings, so an agent is not left guessing at a refusal", () => {
    // Both are rules a reader would otherwise have to discover by being
    // refused: a named colour is only a colour inside CSS, and a `#` inside a
    // reference is a name.
    expect(apps).toContain("**Named colours.**");
    expect(apps).toContain("transparent");
    expect(apps).toContain("**A `#` that is a name.**");
    expect(apps).toContain('querySelector("#abc")');
  });

  it("says a comment hides nothing, and that an unquoted value is read the same", () => {
    expect(apps).toContain("A comment hides nothing");
    expect(apps).toContain("unquoted");
  });

  it("answers state.get in the shape the route actually sends", () => {
    // The route answers `{ state: … ?? null }` every time, so an agent that
    // read "or null" and wrote `if ((await brain.getState()) === null)` gets
    // a truthy object on every call and never takes that branch.
    expect(apps).toContain("`{ state }`, where `state` is `null` when none was kept");
    expect(apps).not.toContain("or `null` for an app that has kept none");
  });
});

/** THE EXAMPLE IS A TEMPLATE, SO IT IS COMPILED AND LINTED HERE.
 *
 *  The block in this document is what an agent copies for its first app, PR
 *  6's trainer included. The first version of it opened with a top-level
 *  `await` inside a classic `<script>`, which is a SyntaxError that takes the
 *  whole block with it and fails in exactly the silent way the document
 *  spends three bullets warning about. Reading it was not enough; these run
 *  it through the same two gates a real entry goes through. */
describe("the example in docs/apps.md", () => {
  const blocks = Array.from(apps.matchAll(/```html\n([\s\S]*?)```/g), (match) => match[1]);
  const scripts = blocks.flatMap((block) =>
    Array.from(block.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]),
  );

  it("has an example with a script in it", () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("parses as a classic script, which is what the frame runs it as", () => {
    // `new Function` parses its body under the same rule a classic script
    // does, so a top-level `await` throws here exactly as it would there.
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("calls only methods the kit defines", () => {
    // Checked against the keys of the kit's own `window.brain` literal, not
    // against the whole of APP_KIT_JS, where a request type such as
    // "state.get" would match a wrong method name by coincidence.
    const literal = APP_KIT_JS.slice(APP_KIT_JS.indexOf("window.brain = {"));
    const defined = new Set(
      Array.from(literal.matchAll(/^ {4}(\w+):/gm), (match) => match[1]),
    );
    expect(defined.size).toBeGreaterThan(5);

    const called = new Set(
      scripts.flatMap((script) =>
        Array.from(script.matchAll(/\bbrain\.(\w+)/g), (match) => match[1]),
      ),
    );
    expect(called.size).toBeGreaterThan(0);
    for (const name of called) expect([...defined]).toContain(name);
  });

  it("passes the lint the tools would run on it", () => {
    const entry = blocks.find((block) => block.includes("<script>"));
    expect(entry).toBeDefined();
    expect(lintAppEntry(entry!)).toBeNull();
  });
});

describe("docs/mcp-tools.md", () => {
  it("has a row for each of the three tools", () => {
    for (const tool of ["create_app_page", "write_app_page", "read_app_page"]) {
      expect(mcp).toContain(`\`${tool}\``);
    }
  });

  it("points at docs/apps.md", () => {
    expect(mcp).toContain("docs/apps.md");
  });

  it("names lint_failed as a refusal an agent can branch on", () => {
    expect(mcp).toContain("lint_failed");
  });
});
