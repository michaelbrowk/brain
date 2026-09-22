import { describe, expect, it } from "vitest";
import { isReservedDir } from "./paths";

describe("folders that are not pages", () => {
  it("reserves an app's own folder", () => {
    // Without this the walk descends into `app/` and `app/assets/` looking
    // for an index.md, which is how an asset becomes a phantom page.
    expect(isReservedDir("app")).toBe(true);
  });

  it("still reserves the four it always did", () => {
    expect(isReservedDir("_attachments")).toBe(true);
    expect(isReservedDir("_tasks")).toBe(true);
    expect(isReservedDir("node_modules")).toBe(true);
    expect(isReservedDir(".git")).toBe(true);
    expect(isReservedDir(".app-next")).toBe(true);
  });

  it("matches the exact name and not a prefix", () => {
    expect(isReservedDir("apps")).toBe(false);
    expect(isReservedDir("app-notes")).toBe(false);
    expect(isReservedDir("App")).toBe(false);
  });
});
