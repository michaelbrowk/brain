import { describe, expect, it } from "vitest";
import {
  APP_ASSETS_MAX_BYTES,
  APP_ENTRY_MAX_BYTES,
  APP_ENTRY_PATH,
  APP_MAX_OWNED,
  APP_STATE_MAX_BYTES,
  appAssetMimeType,
  appAssetPath,
  appMetaSchema,
} from "./model";

const meta = {
  entry: APP_ENTRY_PATH,
  version: 1,
  builtBy: "Claude",
  builtAt: "2026-09-22T10:00:00.000Z",
  owns: ["abc123"],
  state: true,
};

describe("app metadata", () => {
  it("accepts the shape the spec writes into frontmatter", () => {
    expect(appMetaSchema.parse(meta)).toEqual(meta);
  });

  it("refuses an entry that is not the one path an app is served from", () => {
    expect(appMetaSchema.safeParse({ ...meta, entry: "app/other.html" }).success).toBe(false);
    expect(appMetaSchema.safeParse({ ...meta, entry: "../escape.html" }).success).toBe(false);
  });

  it("refuses an owns entry that is not a page id", () => {
    expect(appMetaSchema.safeParse({ ...meta, owns: ["../etc"] }).success).toBe(false);
  });

  it("keeps the one line an agent gave as its reason and bounds it", () => {
    const parsed = appMetaSchema.parse({
      ...meta,
      reason: "build me a trainer for my Spanish words",
    });
    expect(parsed.reason).toBe("build me a trainer for my Spanish words");
    const long = appMetaSchema.parse({ ...meta, reason: "x".repeat(500) });
    expect(long.reason).toHaveLength(280);
    expect(appMetaSchema.parse({ ...meta, reason: "two\nlines" }).reason).toBe("two lines");
  });

  it("states the three caps the spec named", () => {
    expect(APP_ENTRY_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(APP_ASSETS_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(APP_STATE_MAX_BYTES).toBe(256 * 1024);
  });

  it("caps owns in one place, which the schema reads", () => {
    expect(APP_MAX_OWNED).toBe(64);
    const owns = Array.from({ length: APP_MAX_OWNED }, (_, i) => `p${i}`);
    expect(appMetaSchema.safeParse({ ...meta, owns }).success).toBe(true);
    expect(appMetaSchema.safeParse({ ...meta, owns: [...owns, "one-too-many"] }).success).toBe(
      false,
    );
  });

  it("addresses an asset by a relative name and refuses a traversal", () => {
    expect(appAssetPath("cards/front.png")).toBe("app/assets/cards/front.png");
    expect(appAssetPath("a.png")).toBe("app/assets/a.png");
    expect(appAssetPath("../index.html")).toBeNull();
    expect(appAssetPath("/etc/passwd")).toBeNull();
    expect(appAssetPath("a/../../b.png")).toBeNull();
    expect(appAssetPath(".hidden.png")).toBeNull();
    expect(appAssetPath("")).toBeNull();
  });

  it("refuses a name a page walk could mistake for a page", () => {
    // `index.md` under an asset folder is how an app would grow a phantom
    // child page, or collide ids and brick `Store.init()`. No `.md` at all,
    // under any name, at any depth.
    expect(appAssetPath("index.md")).toBeNull();
    expect(appAssetPath("notes.md")).toBeNull();
    expect(appAssetPath("cards/index.md")).toBeNull();
    expect(appAssetPath("INDEX.MD")).toBeNull();
    expect(appAssetMimeType("index.md")).toBeNull();
    expect(appAssetMimeType("a.md")).toBeNull();
  });

  it("serves only the types the spec allows and refuses an executable", () => {
    expect(appAssetMimeType("a.png")).toBe("image/png");
    expect(appAssetMimeType("a.woff2")).toBe("font/woff2");
    expect(appAssetMimeType("a.mp3")).toBe("audio/mpeg");
    expect(appAssetMimeType("a.json")).toBe("application/json");
    expect(appAssetMimeType("a.csv")).toBe("text/csv");
    expect(appAssetMimeType("a.js")).toBeNull();
    expect(appAssetMimeType("a.html")).toBeNull();
    expect(appAssetMimeType("a.wasm")).toBeNull();
  });
});
