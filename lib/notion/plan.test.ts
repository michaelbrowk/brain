import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_CHANNEL_IDS,
  syntheticChannelSnapshot,
  syntheticResolvedAssets,
} from "./channel-fixture.test-helper";
import {
  buildChannelPilotPlan,
  deriveChannelInventory,
  freezeChannelSnapshot,
  produceChannelManifest,
  selectFreshChannelAssetSnapshot,
} from "./plan";

describe("Channel pilot plan", () => {
  it("freezes two equivalent snapshots and builds reverse-sibling parent-first order", async () => {
    const received = await syntheticChannelSnapshot("received");
    const fresh = await syntheticChannelSnapshot("fresh");
    const frozen = freezeChannelSnapshot(received, fresh);
    const plan = buildChannelPilotPlan(
      frozen,
      syntheticResolvedAssets(frozen),
    );

    expect(plan.pages).toHaveLength(16);
    expect(plan.pages[0].notionId).toBe(SYNTHETIC_CHANNEL_IDS.root);
    expect(plan.pages.slice(1, 4).map((page) => page.notionId)).toEqual([
      SYNTHETIC_CHANNEL_IDS.plates,
      SYNTHETIC_CHANNEL_IDS.colophon,
      SYNTHETIC_CHANNEL_IDS.notices,
    ]);
    const sectionsIndex = plan.pages.findIndex(
      (page) => page.notionId === SYNTHETIC_CHANNEL_IDS.sections,
    );
    expect(sectionsIndex).toBe(4);
    expect(plan.pages[sectionsIndex + 1].notionId).toBe(
      SYNTHETIC_CHANNEL_IDS.section(10),
    );
    expect(plan.pageByNotionId.get(SYNTHETIC_CHANNEL_IDS.sections)?.beforeNotionId)
      .toBe(SYNTHETIC_CHANNEL_IDS.notices);
    expect(plan.pageByNotionId.get(SYNTHETIC_CHANNEL_IDS.colophon)?.parentNotionId)
      .toBe(SYNTHETIC_CHANNEL_IDS.plates);
  });

  it("fails before mutation on topology, counters, and unsupported input", async () => {
    const snapshot = await syntheticChannelSnapshot();
    const assets = syntheticResolvedAssets(snapshot);

    const wrongTopology = structuredClone(snapshot);
    const colophon = wrongTopology.pages.find(
      (page) => page.notionId === SYNTHETIC_CHANNEL_IDS.colophon,
    );
    if (!colophon) throw new Error("fixture is missing synthetic colophon");
    colophon.parentNotionId = SYNTHETIC_CHANNEL_IDS.sections;
    expect(() => buildChannelPilotPlan(wrongTopology, assets)).toThrow(
      /topology|Plates|positions/,
    );

    const wrongCount = structuredClone(snapshot);
    wrongCount.manifest.counts.emptyBlocks = 21;
    expect(() => buildChannelPilotPlan(wrongCount, assets)).toThrow(/count mismatch/);

    const unsupported = structuredClone(snapshot);
    unsupported.pages[0].enhancedMarkdown += "\n<database/>";
    expect(() => buildChannelPilotPlan(unsupported, assets)).toThrow(
      /count mismatch: databases/,
    );

    const unsafeIcon = structuredClone(snapshot);
    unsafeIcon.pages[0].icon = "https://example.test/icon.png";
    expect(() => buildChannelPilotPlan(unsafeIcon, assets)).toThrow(
      /incompatible page icon/,
    );
  });

  it("derives manifest counts and selects only fresh signed asset URLs", async () => {
    const received = await syntheticChannelSnapshot("received-token");
    const fresh = await syntheticChannelSnapshot("fresh-token");
    expect(deriveChannelInventory(received.pages)).toEqual(
      received.manifest.counts,
    );
    expect(
      produceChannelManifest(received.manifest.rootNotionId, received.pages),
    ).toEqual(received.manifest);
    const selected = selectFreshChannelAssetSnapshot(received, fresh);
    expect(selected.pages.flatMap((page) => page.assets)).toHaveLength(3);
    expect(
      selected.pages
        .flatMap((page) => page.assets)
        .every((asset) => asset.url.includes("fresh-token")),
    ).toBe(true);
  });

  it("rejects a look-alike Channel inventory with a substituted source id", async () => {
    const snapshot = await syntheticChannelSnapshot();
    const substituted = structuredClone(snapshot);
    substituted.pages.at(-1)!.notionId = "a".repeat(32);
    expect(() =>
      buildChannelPilotPlan(substituted, syntheticResolvedAssets(substituted)),
    ).toThrow(/reviewed Notion ids|topology/);
  });

  it("counts only typed source empty tags and preserves a literal directive line", async () => {
    const snapshot = await syntheticChannelSnapshot();
    snapshot.pages[0].enhancedMarkdown += "\n::empty-block";
    const plan = buildChannelPilotPlan(
      snapshot,
      syntheticResolvedAssets(snapshot),
    );
    expect(
      plan.pages
        .flatMap((page) => page.document.blocks)
        .filter((block) => block.type === "empty_block"),
    ).toHaveLength(22);
    expect(
      plan.pages
        .flatMap((page) => page.document.blocks)
        .filter((block) => block.type === "rich_markdown")
        .flatMap((block) => block.segments)
        .filter((segment) => segment.type === "text")
        .some((segment) => segment.text.includes("\\::empty-block")),
    ).toBe(true);
  });
});
