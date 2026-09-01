#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { BrainMcpClient } from "../lib/notion/brain-mcp-client.ts";
import {
  executeChannelPilot,
  notionPilotErrorCode,
  prepareChannelPilot,
} from "../lib/notion/executor.ts";
import { PilotJournal } from "../lib/notion/journal.ts";
import {
  fetchNotionPngAsset,
  stableNotionAssetId,
  type ResolvedNotionAsset,
} from "../lib/notion/notion-assets.ts";
import {
  buildChannelPilotPlan,
  freezeChannelSnapshot,
  selectFreshChannelAssetSnapshot,
} from "../lib/notion/plan.ts";
import {
  readSnapshotSequenceJsonl,
  type NotionSnapshot,
} from "../lib/notion/snapshot.ts";

interface Arguments {
  mode: "plan" | "apply" | "verify";
  journal?: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const [received, fresh] = await readSnapshotSequenceJsonl(
    process.stdin as AsyncIterable<Uint8Array>,
    { expectedSnapshots: 2 },
  );
  const frozen = freezeChannelSnapshot(received, fresh);
  // This full no-network plan is the authorization and fidelity gate. It must
  // finish before credentials are required or a signed asset URL is resolved.
  const sourceOnlyPlan = buildChannelPilotPlan(frozen, previewAssets(frozen));
  if (args.mode === "plan") {
    safeOutput({
      ok: true,
      mode: "plan",
      pages: sourceOnlyPlan.counts.pages,
      attachments: sourceOnlyPlan.counts.assets,
      emptyBlocks: sourceOnlyPlan.counts.emptyBlocks,
      hardBreaks: sourceOnlyPlan.counts.hardBreaks,
      externalLinks: sourceOnlyPlan.counts.externalLinks,
      network: false,
      mutations: false,
      brainReadOnly: true,
      localAuditJournal: false,
    });
    return;
  }

  if (!args.journal || !path.isAbsolute(args.journal)) {
    throw new Error("apply and verify require an absolute --journal path");
  }
  const endpoint = process.env.BRAIN_MCP_URL;
  const token = process.env.MCP_TOKEN;
  if (!endpoint || !token) {
    throw new Error("apply and verify require Brain MCP environment");
  }
  const assets = await resolveAssets(
    selectFreshChannelAssetSnapshot(received, fresh),
  );
  const prepared = prepareChannelPilot(received, fresh, assets);
  const journal = await PilotJournal.open(args.journal);
  try {
    const result = await executeChannelPilot({
      prepared,
      client: new BrainMcpClient({
        endpoint,
        token,
        ...(process.env.BRAIN_MCP_ALLOWED_ORIGIN
          ? { allowedOrigin: process.env.BRAIN_MCP_ALLOWED_ORIGIN }
          : {}),
      }),
      journal,
      mode: args.mode,
    });
    safeOutput({
      ok: true,
      mode: result.mode,
      pages: result.pages,
      attachments: result.attachments,
      verified: result.verified,
      remoteMutations: result.remoteMutations,
      brainReadOnly: result.mode === "verify",
      localAuditJournal: true,
    });
  } finally {
    await journal.close();
  }
}

function parseArguments(argv: string[]): Arguments {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: pnpm notion:pilot [--apply|--verify] [--journal /absolute/path]",
        "",
        "Reads exactly two strict Channel snapshot JSONL sequences from stdin.",
        "Default plan mode performs no network requests or mutations.",
        "--apply is the only mode that can mutate Brain.",
        "--verify is Brain-read-only but creates/appends the local audit journal.",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  let mode: Arguments["mode"] = "plan";
  let journal: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply" || argument === "--verify") {
      if (mode !== "plan") throw new Error("choose only one pilot mode");
      mode = argument === "--apply" ? "apply" : "verify";
      continue;
    }
    if (argument === "--journal") {
      journal = argv[index + 1];
      if (!journal) throw new Error("--journal requires a path");
      index += 1;
      continue;
    }
    throw new Error("unknown pilot argument");
  }
  if (mode === "plan" && journal) {
    throw new Error("plan mode does not open a journal");
  }
  return { mode, journal };
}

async function resolveAssets(
  snapshot: NotionSnapshot,
): Promise<Map<string, ResolvedNotionAsset>> {
  const result = new Map<string, ResolvedNotionAsset>();
  for (const source of snapshot.pages.flatMap((page) => page.assets)) {
    if (source.kind !== "image") {
      throw new Error("Channel pilot accepts only PNG image assets");
    }
    const asset = await fetchNotionPngAsset({
      url: source.url,
      name: source.name,
    });
    if (result.has(asset.sourceId)) {
      throw new Error("Channel pilot resolved a duplicate asset");
    }
    result.set(asset.sourceId, asset);
  }
  return result;
}

function previewAssets(
  snapshot: NotionSnapshot,
): Map<string, ResolvedNotionAsset> {
  const result = new Map<string, ResolvedNotionAsset>();
  for (const source of snapshot.pages.flatMap((page) => page.assets)) {
    const sourceId = stableNotionAssetId(source.url);
    result.set(sourceId, {
      sourceId,
      name: source.name,
      mimeType: "image/png",
      sha256: createHash("sha256").update(sourceId).digest("hex"),
      bytes: new Uint8Array(),
    });
  }
  return result;
}

function safeOutput(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

main().catch((error: unknown) => {
  const code = notionPilotErrorCode(error);
  safeOutput({
    ok: false,
    error: "notion_pilot_failed",
    ...(code ? { code } : {}),
  });
  process.exitCode = 1;
});
