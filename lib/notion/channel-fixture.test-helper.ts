import { createHash } from "node:crypto";
import type { ResolvedNotionAsset } from "./notion-assets";
import { stableNotionAssetId } from "./notion-assets";
import { CHANNEL_PILOT_TOPOLOGY } from "./plan";
import {
  readSnapshotJsonl,
  type NotionSnapshot,
  type SnapshotPageRecord,
} from "./snapshot";

export const SYNTHETIC_CHANNEL_IDS = {
  root: CHANNEL_PILOT_TOPOLOGY[0][0],
  sections: CHANNEL_PILOT_TOPOLOGY[1][0],
  notices: CHANNEL_PILOT_TOPOLOGY[2][0],
  plates: CHANNEL_PILOT_TOPOLOGY[3][0],
  section: (index: number) => CHANNEL_PILOT_TOPOLOGY[4 + index][0],
  colophon: CHANNEL_PILOT_TOPOLOGY[15][0],
};

export async function syntheticChannelSnapshot(
  assetQuery = "received",
): Promise<NotionSnapshot> {
  const ids = SYNTHETIC_CHANNEL_IDS;
  const assetUrls = Array.from(
    { length: 3 },
    (_, index) =>
      "https://file.notion.so/f/synthetic/channel-" +
      index +
      ".png?token=" +
      assetQuery,
  );
  const rootMarkdown = [
    "Synthetic channel",
    ...Array.from({ length: 22 }, () => "<empty-block/>"),
    "one<br>two<br>three",
    ...Array.from(
      { length: 7 },
      (_, index) => "[external-" + index + "](https://example.test/" + index + ")",
    ),
    "[section](https://www.notion.so/Synthetic-" + ids.section(0) + ")",
  ].join("\n");
  const pages: SnapshotPageRecord[] = [
    page(ids.root, null, 0, "Channel", rootMarkdown),
    page(ids.sections, ids.root, 0, "Sections"),
    page(
      ids.plates,
      ids.root,
      2,
      "Plates",
      assetUrls
        .map((url, index) => "![image-" + index + "](" + url + ")")
        .join("\n"),
      assetUrls.map((url, index) => ({
        url,
        name: "channel-" + index + ".png",
        kind: "image" as const,
      })),
    ),
    page(ids.notices, ids.root, 1, "Notices"),
    page(ids.colophon, ids.plates, 0, "Colophon"),
    ...Array.from({ length: 11 }, (_, index) =>
      page(ids.section(index), ids.sections, index, "Section " + index),
    ),
  ];
  const records = [
    {
      type: "manifest",
      version: 1,
      pilot: "channel",
      rootNotionId: ids.root,
      counts: {
        pages: 16,
        assets: 3,
        emptyBlocks: 22,
        hardBreaks: 2,
        externalLinks: 7,
        databases: 0,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    ...pages,
    { type: "end", pageCount: 16, assetCount: 3 },
  ];
  return readSnapshotJsonl(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

export function syntheticResolvedAssets(
  snapshot: NotionSnapshot,
): Map<string, ResolvedNotionAsset> {
  const resolved = new Map<string, ResolvedNotionAsset>();
  for (const source of snapshot.pages.flatMap((page) => page.assets)) {
    const sourceId = stableNotionAssetId(source.url);
    const bytes = new TextEncoder().encode("synthetic-" + sourceId);
    resolved.set(sourceId, {
      sourceId,
      name: source.name,
      mimeType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  }
  return resolved;
}

function page(
  notionId: string,
  parentNotionId: string | null,
  position: number,
  title: string,
  enhancedMarkdown = "",
  assets: SnapshotPageRecord["assets"] = [],
): SnapshotPageRecord {
  return {
    type: "page",
    notionId,
    parentNotionId,
    position,
    title,
    enhancedMarkdown,
    assets,
  };
}
