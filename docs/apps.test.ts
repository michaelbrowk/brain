import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ASSETS_MAX_BYTES,
  APP_ENTRY_MAX_BYTES,
  APP_STATE_MAX_BYTES,
} from "@/lib/apps/model";
import { APP_KIT_CSS } from "@/lib/apps/kit";

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
