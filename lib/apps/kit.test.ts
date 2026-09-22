import { describe, expect, it } from "vitest";
import { APP_KIT_CSS, APP_KIT_JS, injectAppKit } from "./kit";
import { BRIDGE_VERSION } from "./bridge";
import { APP_TOKEN_NAMES } from "./tokens";
import { lintAppEntry } from "./lint";

describe("the Brain app kit", () => {
  it("defines the register classes with the same names Brain uses", () => {
    for (const name of [".text-title", ".text-body", ".text-caption", ".text-label"]) {
      expect(APP_KIT_CSS).toContain(name);
    }
  });

  it("defines the five controls the spec named", () => {
    for (const name of [".btn", ".field", ".chip", ".card", ".row"]) {
      expect(APP_KIT_CSS).toContain(name);
    }
  });

  it("declares the colour scheme so the frame follows the theme", () => {
    expect(APP_KIT_CSS).toContain("color-scheme: light dark");
  });

  it("writes no colour of its own, only tokens", () => {
    expect(APP_KIT_CSS.replace(/var\(\s*--[^)]*\)/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(APP_KIT_CSS.replace(/var\(\s*--[^)]*\)/g, "")).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
  });

  it("gives every control a 44px touch target", () => {
    expect(APP_KIT_CSS).toContain("min-height: 44px");
  });

  it("names every token it reads", () => {
    for (const token of ["--paper", "--ink", "--ink-3", "--r-md", "--font-sf"]) {
      expect(APP_TOKEN_NAMES).toContain(token);
      expect(APP_KIT_CSS).toContain(`var(${token}`);
    }
  });

  it("gives the app one method per bridge request", () => {
    for (const method of [
      "readTree",
      "readPage",
      "readPages",
      "writePage",
      "createPage",
      "getState",
      "setState",
      "open",
      "toast",
    ]) {
      expect(APP_KIT_JS).toContain(method);
    }
  });

  it("applies the tokens it is given and repaints on a theme event", () => {
    expect(APP_KIT_JS).toContain("setProperty");
    expect(APP_KIT_JS).toContain('"theme"');
    expect(APP_KIT_JS).toContain('"visibility"');
  });

  it("speaks the protocol's own version rather than a copy of the number", () => {
    // The kit is a string, so a literal 1 in it is a second place the version
    // lives and the two can part company at the next bump with nothing red.
    expect(APP_KIT_JS).toContain(`v: ${BRIDGE_VERSION}`);
    expect(APP_KIT_JS).toContain(`!== ${BRIDGE_VERSION}`);
  });

  it("keeps asking for hello until the host answers", () => {
    // The frame's script runs before the host's message listener is
    // guaranteed to be attached: React mounts the iframe and the effect that
    // installs the listener runs after the load. One unanswered hello would
    // leave an app with no tokens and no theme, painted in the browser's
    // defaults, forever.
    expect(APP_KIT_JS).toContain("setTimeout");
    expect(APP_KIT_JS).toContain("HELLO_RETRY_MS");
  });

  it("replaces the kit link with the kit itself and leaves anything else alone", () => {
    const html =
      '<!doctype html><meta name="color-scheme" content="light dark"><link rel="brain-kit"><p>x</p>';
    const injected = injectAppKit(html);
    expect(injected).not.toContain("brain-kit");
    expect(injected).toContain("<style>");
    expect(injected).toContain("<script>");
    expect(injected).toContain("<p>x</p>");

    const bare = "<!doctype html><p>x</p>";
    expect(injectAppKit(bare)).toBe(bare);
  });

  it("passes its own lint, so the example cannot be refused by the kit it uses", () => {
    expect(
      lintAppEntry(
        `<!doctype html><meta name="color-scheme" content="light dark"><style>${APP_KIT_CSS}</style>`,
      ),
    ).toBeNull();
  });

  it("carries no em-dash in a string an app's user could see", () => {
    expect(APP_KIT_JS).not.toContain("—");
  });
});
