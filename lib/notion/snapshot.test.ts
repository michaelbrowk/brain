import { describe, expect, it } from "vitest";
import {
  assertSnapshotsMatch,
  readSnapshotJsonl,
  readSnapshotSequenceJsonl,
} from "./snapshot";

const ROOT = "1".repeat(32);
const CHILD = "2".repeat(32);

function snapshotJson(assetQuery = "one", externalQuery = "one"): string {
  const asset = `https://file.notion.so/f/synthetic/image.png?token=${assetQuery}`;
  const records = [
    {
      type: "manifest",
      version: 1,
      pilot: "channel",
      rootNotionId: ROOT,
      counts: {
        pages: 2,
        assets: 1,
        emptyBlocks: 1,
        hardBreaks: 1,
        externalLinks: 1,
        databases: 0,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    {
      type: "page",
      notionId: ROOT,
      parentNotionId: null,
      position: 0,
      title: "Synthetic root",
      enhancedMarkdown: `[external](https://example.test/?q=${externalQuery})`,
      assets: [],
    },
    {
      type: "page",
      notionId: CHILD,
      parentNotionId: ROOT,
      position: 0,
      title: "Synthetic child",
      enhancedMarkdown: `before<br>after\n\n<empty-block/>\n\n![asset](${asset})`,
      assets: [{ url: asset, name: "image.png", kind: "image" }],
    },
    { type: "end", pageCount: 2, assetCount: 1 },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("strict Notion snapshot JSONL", () => {
  it("parses manifest/page/end and normalizes a stable received set", async () => {
    const first = await readSnapshotJsonl(snapshotJson("one"));
    const fresh = await readSnapshotJsonl(snapshotJson("two"));
    expect(first.pages).toHaveLength(2);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh.fingerprint).toBe(first.fingerprint);
    expect(() => assertSnapshotsMatch(first, fresh)).not.toThrow();
  });

  it("keeps meaningful external-link queries in the freeze fingerprint", async () => {
    const first = await readSnapshotJsonl(snapshotJson("one", "one"));
    const changed = await readSnapshotJsonl(snapshotJson("two", "two"));
    expect(() => assertSnapshotsMatch(first, changed)).toThrow(/does not match/);
  });

  it("reads exactly two fresh snapshots from one stdin sequence", async () => {
    const snapshots = await readSnapshotSequenceJsonl(
      snapshotJson("one") + snapshotJson("two"),
      { expectedSnapshots: 2 },
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].fingerprint).toBe(snapshots[1].fingerprint);
  });

  it("rejects unknown fields, duplicate ids, counts, and byte overflow", async () => {
    const unknown = snapshotJson().replace(
      '"pilot":"channel"',
      '"pilot":"channel","secret":"no"',
    );
    await expect(readSnapshotJsonl(unknown)).rejects.toThrow(/unknown fields/);

    const duplicate = snapshotJson().replace(`"notionId":"${CHILD}"`, `"notionId":"${ROOT}"`);
    await expect(readSnapshotJsonl(duplicate)).rejects.toThrow(/duplicate/);

    const badCount = snapshotJson().replace('"pageCount":2', '"pageCount":3');
    await expect(readSnapshotJsonl(badCount)).rejects.toThrow(/count mismatch/);

    await expect(
      readSnapshotJsonl(snapshotJson(), { maxBytes: 32, maxLineBytes: 32 }),
    ).rejects.toThrow(/byte limit/);
  });
});
