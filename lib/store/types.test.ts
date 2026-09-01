import { describe, expect, it } from "vitest";
import { redactPage } from "./types";

describe("client page redaction", () => {
  it("never exposes share hashes or Notion reservation ownership", () => {
    const page = redactPage({
      meta: {
        id: "page",
        title: "Private",
        order: "a0",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        font: "mono",
        smallText: true,
        fullWidth: true,
        sharePass: "bcrypt-hash",
        notionId: "a".repeat(32),
        notionImportHash: "b".repeat(64),
        notionImportToken: "secret-reservation-token",
        notionImportStarted: "2026-01-01T00:00:00.000Z",
        notionImportBaseRev: "c".repeat(64),
        notionImportOwnedCover: `/_attachments-v2/${"d".repeat(64)}.png`,
        notionImportParentId: null,
        notionImportBeforeId: null,
        notionImportBaseParentId: null,
        notionImportBaseOrder: "a0",
        structureWriteBarrier: true,
      },
      markdown: "body",
      rev: "rev",
    });

    expect(page.meta).toMatchObject({
      id: "page",
      notionId: "a".repeat(32),
      font: "mono",
      smallText: true,
      fullWidth: true,
    });
    expect(page.meta.sharePass).toBeUndefined();
    expect(page.meta.notionImportToken).toBeUndefined();
    expect(page.meta.notionImportHash).toBeUndefined();
    expect(page.meta.notionImportBaseRev).toBeUndefined();
    expect(page.meta.notionImportOwnedCover).toBeUndefined();
    expect(page.meta.structureWriteBarrier).toBeUndefined();
  });
});
