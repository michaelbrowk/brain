import type {
  CollectionDefinition,
  CollectionRow,
} from "../collections/model.ts";
import type { NotionImportDocument } from "./converter.ts";

/**
 * Source-agnostic shape consumed by the two-pass Notion executor. Adapters may
 * impose stricter source-specific gates, but they must materialize this exact
 * immutable shape before any remote mutation is considered.
 */
export interface NotionExecutionPage {
  notionId: string;
  parentNotionId: string | null;
  beforeNotionId: string | null;
  position: number;
  title: string;
  document: NotionImportDocument;
  collection?: CollectionDefinition | null;
  collectionRow?: CollectionRow | null;
  sourceHash: string;
  assetSourceIds: string[];
}

export interface NotionExecutionCounts {
  pages: number;
  assets: number;
  emptyBlocks: number;
  hardBreaks: number;
  externalLinks: number;
}

export interface NotionExecutionPlan<
  Page extends NotionExecutionPage = NotionExecutionPage,
  Counts extends NotionExecutionCounts = NotionExecutionCounts,
> {
  fingerprint: string;
  rootNotionId: string;
  pages: Page[];
  pageByNotionId: ReadonlyMap<string, Page>;
  counts: Counts;
}
