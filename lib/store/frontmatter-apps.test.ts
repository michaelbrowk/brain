import { describe, expect, it } from "vitest";
import { APP_ENTRY_PATH, appMetaSchema } from "../apps/model";
import { parsePage, serializePage } from "./frontmatter";
import type { PageMeta } from "./types";

const baseMeta: PageMeta = {
  id: "trainer-page",
  title: "Trainer",
  icon: "🃏",
  order: "a0",
  created: "2026-09-22T10:00:00.000Z",
  updated: "2026-09-22T10:00:00.000Z",
};

const app = appMetaSchema.parse({
  entry: APP_ENTRY_PATH,
  version: 1,
  builtBy: "Claude",
  builtAt: "2026-09-22T10:00:00.000Z",
  owns: ["words123"],
  state: true,
  reason: "build me a trainer for the Spanish words I am learning",
});

describe("app page frontmatter", () => {
  it("round-trips kind and the app map", () => {
    const first = serializePage(
      { ...baseMeta, kind: "app", app },
      "Trainer for the words under Spanish.",
    );
    const parsed = parsePage(first);

    expect(parsed.meta.kind).toBe("app");
    expect(appMetaSchema.parse(parsed.meta.app)).toEqual(app);
    expect(parsed.markdown).toBe("Trainer for the words under Spanish.");
    expect(serializePage(parsed.meta as PageMeta, parsed.markdown)).toBe(first);
  });

  it("writes kind and app after the icon and before the order key", () => {
    const raw = serializePage({ ...baseMeta, kind: "app", app }, "Body");
    expect(raw.indexOf("icon:")).toBeLessThan(raw.indexOf("kind:"));
    expect(raw.indexOf("kind:")).toBeLessThan(raw.indexOf("app:"));
    expect(raw.indexOf("app:")).toBeLessThan(raw.indexOf("order:"));
  });

  it("keeps the app map's own keys in the spec's order", () => {
    const raw = serializePage({ ...baseMeta, kind: "app", app }, "Body");
    const keys = ["entry:", "version:", "builtBy:", "builtAt:", "owns:", "state:", "reason:"];
    const positions = keys.map((key) => raw.indexOf(key));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("omits both keys on an ordinary page", () => {
    const raw = serializePage(baseMeta, "Body");
    expect(raw).not.toContain("kind:");
    expect(raw).not.toContain("app:");
  });

  it("carries a foreign frontmatter key through beside them", () => {
    const raw = serializePage(
      { ...baseMeta, kind: "app", app, inbox: true } as PageMeta & { inbox: boolean },
      "Body",
    );
    expect(raw).toContain("inbox: true");
    expect(raw.indexOf("app:")).toBeLessThan(raw.indexOf("inbox:"));
  });
});
