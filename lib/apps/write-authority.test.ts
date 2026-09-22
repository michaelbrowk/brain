import { describe, expect, it } from "vitest";
import { appWriteClient } from "./write-authority";

describe("how an app is named in the activity log", () => {
  it("is the app page's title with the word app after it", () => {
    expect(appWriteClient("Trainer")).toBe("Trainer (app)");
  });

  it("collapses a title to one line and bounds it", () => {
    expect(appWriteClient(" Two\nlines ")).toBe("Two lines (app)");
    expect(appWriteClient("x".repeat(200))).toHaveLength(106);
  });

  it("names an untitled app something rather than nothing", () => {
    expect(appWriteClient("   ")).toBe("An app (app)");
  });
});
