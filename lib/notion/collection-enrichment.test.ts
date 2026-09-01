import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCollectionEnrichmentManifest,
  readPrivateCollectionEnrichmentFile,
} from "./collection-enrichment";

const DATABASE_ID = "1".repeat(32);
const DATA_SOURCE_ID = "2".repeat(32);
const PARENT_ID = "3".repeat(32);
const ROW_ID = "4".repeat(32);

function manifest() {
  return {
    version: 1,
    source: "notion-mcp-reviewed",
    capturedAt: "2026-07-12T12:00:00.000Z",
    stableConsecutiveCaptures: true,
    collections: [
      {
        notionId: DATABASE_ID,
        parentNotionId: PARENT_ID,
        title: "Synthetic",
        definition: {
          version: 1,
          source: "notion",
          databaseId: DATABASE_ID,
          dataSourceId: DATA_SOURCE_ID,
          titlePropertyId: "title",
          properties: [
            { id: "title", name: "Name", type: "title", position: 0 },
          ],
          views: [
            {
              id: "all",
              name: "All",
              type: "table",
              rowNotionIds: [ROW_ID],
            },
          ],
          initialViewId: "all",
        },
        rows: [
          {
            notionId: ROW_ID,
            title: "Untitled",
            collectionRow: {
              version: 1,
              source: "notion",
              databaseId: DATABASE_ID,
              values: { title: { type: "title", value: "" } },
            },
          },
        ],
      },
    ],
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("reviewed collection enrichment", () => {
  it("normalizes ids, preserves an empty source title, and fingerprints", () => {
    const value = manifest();
    value.collections[0].notionId = `${"1".repeat(8)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(12)}`;
    const parsed = parseCollectionEnrichmentManifest(JSON.stringify(value));
    expect(parsed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.collectionByNotionId.get(DATABASE_ID)?.rows[0]).toMatchObject({
      title: "Untitled",
      collectionRow: { values: { title: { value: "" } } },
    });
  });

  it("fails closed on unknown view rows, mismatched schema, and unreachable rows", () => {
    const unknown = manifest();
    unknown.collections[0].definition.views[0].rowNotionIds = ["5".repeat(32)];
    expect(() =>
      parseCollectionEnrichmentManifest(JSON.stringify(unknown)),
    ).toThrow();

    const wrongDatabase = manifest();
    wrongDatabase.collections[0].rows[0].collectionRow.databaseId = "6".repeat(32);
    expect(() =>
      parseCollectionEnrichmentManifest(JSON.stringify(wrongDatabase)),
    ).toThrow();

    const unreachable = manifest();
    unreachable.collections[0].definition.views[0].rowNotionIds = [];
    expect(() =>
      parseCollectionEnrichmentManifest(JSON.stringify(unreachable)),
    ).toThrow();
  });

  it("reads only an owned 0600 file under a real 0700 private directory", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-collection-enrichment-"),
    );
    temporaryDirectories.push(directory);
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, "enrichment.json");
    await fs.writeFile(file, JSON.stringify(manifest()), { mode: 0o600 });
    await fs.chmod(file, 0o600);

    await expect(
      readPrivateCollectionEnrichmentFile(file, [process.cwd()]),
    ).resolves.toMatchObject({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });

    await fs.chmod(file, 0o644);
    await expect(
      readPrivateCollectionEnrichmentFile(file, [process.cwd()]),
    ).rejects.toThrow(/mode must be 0600/);
  });

  it("rejects an enrichment manifest with another hard link", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-collection-enrichment-hardlink-"),
    );
    temporaryDirectories.push(directory);
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, "enrichment.json");
    const alias = path.join(directory, "enrichment-alias.json");
    await fs.writeFile(file, JSON.stringify(manifest()), { mode: 0o600 });
    await fs.link(file, alias);

    await expect(readPrivateCollectionEnrichmentFile(file)).rejects.toThrow(
      /multiple hard links/,
    );
  });
});
