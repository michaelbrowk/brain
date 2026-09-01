import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AbortNotionImportInput,
  AbortNotionImportResult,
  AdoptNotionImportInput,
  AdoptNotionImportResult,
  FinalizeNotionImportInput,
  FinalizeNotionImportResult,
  NotionCandidateBaseline,
  NotionImportStatus,
  PageMeta,
  ReserveNotionImportInput,
  ReserveNotionImportResult,
  SavedAttachment,
  TreeNode,
  VerifiedNotionAttachment,
} from "../store/types";
import { redactPage } from "../store/types";
import { Store } from "../store/store";
import { serializePage } from "../store/frontmatter";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrainImportClient,
  BrainReadPage,
} from "./brain-mcp-client";
import { parseNotionBindingsJson } from "./bindings";
import { executeNotionExecution, preflightNotionExecution } from "./executor";
import { materializeGenericNotionSnapshotNode } from "./generic-materializer";
import {
  buildGenericNotionImportPlan,
  prepareGenericNotionExecution,
} from "./generic-plan";
import { PilotJournal } from "./journal";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
} from "./protocol";
import { readNotionSnapshotV2Jsonl } from "./snapshot-v2";

const ROOT_NOTION_ID = "1".repeat(32);
const CREATE_NOTION_ID = "2".repeat(32);
const ADOPT_NOTION_ID = "3".repeat(32);
const ADOPT_TWO_NOTION_ID = "4".repeat(32);
const PRESERVE_CHILD_NOTION_ID = "5".repeat(32);
const tempDirectories: string[] = [];

interface SourceChild {
  notionId: string;
  title: string;
  markdown: string;
  disposition: "create" | "adopt" | "preserve";
}

interface GenericFixture {
  store: Store;
  rootId: string;
  candidateIds: Map<string, string>;
  expectedRevs: Map<string, string>;
  prepared: ReturnType<typeof prepareGenericNotionExecution>;
}

interface GenericFixtureOptions {
  candidateMetaByNotionId?: ReadonlyMap<string, Partial<PageMeta>>;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generic Notion preserve/adopt executor", () => {
  it("runs the destination drift gate without opening a journal", async () => {
    const fixture = await genericFixture([
      {
        notionId: CREATE_NOTION_ID,
        title: "Created",
        markdown: "created body",
        disposition: "create",
      },
    ]);
    const client = new StoreBackedBrainClient(fixture.store);
    await expect(
      preflightNotionExecution({
        prepared: fixture.prepared,
        client,
        mode: "apply",
      }),
    ).resolves.toMatchObject({ pages: 1, fixedPages: 1, adoptions: 0 });
    expect(client.mutationLog).toEqual([]);

    const root = await fixture.store.readPage(fixture.rootId);
    await fixture.store.writePage(
      fixture.rootId,
      "drift after reviewed bindings",
      root.rev,
      "me",
    );
    await expect(
      preflightNotionExecution({
        prepared: fixture.prepared,
        client,
        mode: "apply",
      }),
    ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
    expect(client.mutationLog).toEqual([]);
  });

  it("preflights fixed anchors, adopts before reserve, and verifies idempotently", async () => {
    const fixture = await genericFixture([
      {
        notionId: CREATE_NOTION_ID,
        title: "Created",
        markdown: "created body",
        disposition: "create",
      },
      {
        notionId: ADOPT_NOTION_ID,
        title: "Adopted",
        markdown: "existing body",
        disposition: "adopt",
      },
    ]);
    const client = new StoreBackedBrainClient(fixture.store);
    const { journal } = await temporaryJournal();
    let token = 0;
    const tokenFactory = () => `generic_token_${String(++token).padStart(8, "0")}`;
    const rootRev = (await fixture.store.readPage(fixture.rootId)).rev;

    const applied = await executeNotionExecution({
      prepared: fixture.prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory,
    });
    expect(applied).toMatchObject({
      pages: 2,
      remoteMutations: { reserves: 2, uploads: 0, finalizes: 1, aborts: 0 },
      verified: 2,
    });
    expect(client.mutationLog[0]).toBe(`adopt:${ADOPT_NOTION_ID}`);
    expect(client.mutationLog.findIndex((event) => event.startsWith("reserve")))
      .toBeGreaterThan(0);
    expect((await fixture.store.readPage(fixture.rootId)).rev).toBe(rootRev);
    expect(childTitles(fixture.store.getTree(), fixture.rootId)).toEqual([
      "Created",
      "Adopted",
    ]);
    expect(
      (await fixture.store.readPage(
        fixture.candidateIds.get(ADOPT_NOTION_ID)!,
      )).markdown,
    ).toBe("existing body");
    expect(
      journal.records.filter((record) => record.event.type === "page_adopted"),
    ).toHaveLength(1);

    const mutationCount = client.mutationLog.length;
    const journalCount = journal.records.length;
    const rerun = await executeNotionExecution({
      prepared: fixture.prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory,
    });
    expect(rerun.remoteMutations).toEqual({
      reserves: 0,
      uploads: 0,
      finalizes: 0,
      aborts: 0,
    });
    expect(client.mutationLog).toHaveLength(mutationCount);
    expect(
      journal.records.slice(journalCount).map((record) => record.event),
    ).toEqual([]);

    const verified = await executeNotionExecution({
      prepared: fixture.prepared,
      client,
      journal,
      mode: "verify",
    });
    expect(verified.verified).toBe(2);
    expect(client.mutationLog).toHaveLength(mutationCount);
    expect(journal.records).toHaveLength(journalCount);
    await journal.close();
  });

  it.each(["preserve_rev", "preserve_parent", "preserve_before", "adopt_placement"] as const)(
    "writes no journal and performs no mutation when %s drifts",
    async (drift) => {
      const fixture = await genericFixture(
        drift === "preserve_parent" || drift === "preserve_before"
          ? [
              {
                notionId: CREATE_NOTION_ID,
                title: "Created",
                markdown: "created body",
                disposition: "create",
              },
              {
                notionId: PRESERVE_CHILD_NOTION_ID,
                title: "Preserved",
                markdown: "preserved body",
                disposition: "preserve",
              },
            ]
          : [
              {
                notionId: ADOPT_NOTION_ID,
                title: "Adopted",
                markdown: "existing body",
                disposition: "adopt",
              },
            ],
      );
      if (drift === "preserve_rev") {
        const read = await fixture.store.readPage(fixture.rootId);
        await fixture.store.writePage(
          fixture.rootId,
          "manual root edit",
          read.rev,
          "me",
        );
      } else if (drift === "preserve_parent") {
        const preservedId = fixture.candidateIds.get(PRESERVE_CHILD_NOTION_ID)!;
        const external = await fixture.store.createPage(null, "External parent");
        await fixture.store.movePage(external.id, null, fixture.rootId);
        const sourceDirectory = fixture.store.resolve(preservedId);
        await fs.rename(
          sourceDirectory,
          path.join(
            fixture.store.resolve(external.id),
            path.basename(sourceDirectory),
          ),
        );
        const reloaded = new Store(fixture.store.root);
        await reloaded.init();
        fixture.store = reloaded;
      } else if (drift === "preserve_before") {
        await fixture.store.createPage(fixture.rootId, "Later sibling");
      } else {
        await fixture.store.createPage(fixture.rootId, "Later sibling");
      }
      if (drift === "preserve_parent" || drift === "preserve_before") {
        const preservedId = fixture.candidateIds.get(PRESERVE_CHILD_NOTION_ID)!;
        expect((await fixture.store.readPage(preservedId)).rev).toBe(
          fixture.expectedRevs.get(PRESERVE_CHILD_NOTION_ID),
        );
      }
      const client = new StoreBackedBrainClient(fixture.store);
      const { journal } = await temporaryJournal();
      await expect(
        executeNotionExecution({
          prepared: fixture.prepared,
          client,
          journal,
          mode: "apply",
          tokenFactory: () => "must_not_be_used_0001",
        }),
      ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
      expect(journal.records).toHaveLength(0);
      expect(client.mutationLog).toHaveLength(0);
      await journal.close();
    },
  );

  it("recovers a durable adoption whose acknowledgement was lost, then resumes remaining adoptions", async () => {
    const fixture = await genericFixture([
      {
        notionId: ADOPT_NOTION_ID,
        title: "First",
        markdown: "first body",
        disposition: "adopt",
      },
      {
        notionId: ADOPT_TWO_NOTION_ID,
        title: "Second",
        markdown: "second body",
        disposition: "adopt",
      },
    ]);
    const firstClient = new StoreBackedBrainClient(fixture.store);
    firstClient.loseAdoptionAcknowledgement = 1;
    const { journal, file } = await temporaryJournal();
    await expect(
      executeNotionExecution({
        prepared: fixture.prepared,
        client: firstClient,
        journal,
        mode: "apply",
      }),
    ).rejects.toThrow(/lost adoption acknowledgement/);
    expect(firstClient.mutationLog).toEqual([
      `adopt:${ADOPT_TWO_NOTION_ID}`,
    ]);
    expect(
      journal.records.filter((record) => record.event.type === "page_adopted"),
    ).toHaveLength(0);
    expect(journal.latest("run_stopped")).toMatchObject({
      phase: "execution",
    });
    await journal.close();

    const resumedJournal = await PilotJournal.open(file);
    const resumedClient = new StoreBackedBrainClient(fixture.store);
    const resumed = await executeNotionExecution({
      prepared: fixture.prepared,
      client: resumedClient,
      journal: resumedJournal,
      mode: "apply",
    });
    expect(resumed.verified).toBe(2);
    expect(resumedClient.mutationLog).toEqual([
      `adopt:${ADOPT_NOTION_ID}`,
    ]);
    const adoptionEvents = resumedJournal.records.filter(
      (record) => record.event.type === "page_adopted",
    );
    expect(adoptionEvents).toHaveLength(2);
    expect(
      adoptionEvents.some(
        (record) => record.event.recoveredAcknowledgement === true,
      ),
    ).toBe(true);
    expect(
      await fixture.store.inspectNotionCandidate(
        fixture.candidateIds.get(ADOPT_NOTION_ID)!,
      ),
    ).toMatchObject({ bindingState: "tracked", notionId: ADOPT_NOTION_ID });
    expect(
      await fixture.store.inspectNotionCandidate(
        fixture.candidateIds.get(ADOPT_TWO_NOTION_ID)!,
      ),
    ).toMatchObject({ bindingState: "tracked", notionId: ADOPT_TWO_NOTION_ID });

    const journalCount = resumedJournal.records.length;
    const stableClient = new StoreBackedBrainClient(fixture.store);
    await executeNotionExecution({
      prepared: fixture.prepared,
      client: stableClient,
      journal: resumedJournal,
      mode: "apply",
    });
    expect(stableClient.mutationLog).toHaveLength(0);
    expect(resumedJournal.records).toHaveLength(journalCount);
    await resumedJournal.close();
  });

  it("upgrades an exact legacy binding and recovers a lost adoption acknowledgement", async () => {
    const fixture = await genericFixture(
      [
        {
          notionId: ADOPT_NOTION_ID,
          title: "Legacy",
          markdown: "legacy body",
          disposition: "adopt",
        },
      ],
      {
        candidateMetaByNotionId: new Map([
          [ADOPT_NOTION_ID, { notionId: ADOPT_NOTION_ID }],
        ]),
      },
    );
    const pageId = fixture.candidateIds.get(ADOPT_NOTION_ID)!;
    const before = await fixture.store.readPage(pageId);
    await expect(fixture.store.inspectNotionCandidate(pageId)).resolves.toMatchObject({
      bindingState: "bound_untracked",
      notionId: ADOPT_NOTION_ID,
      legacyBindingUpgradeable: true,
    });

    const firstClient = new StoreBackedBrainClient(fixture.store);
    firstClient.loseAdoptionAcknowledgement = 1;
    const { journal } = await temporaryJournal();
    await expect(
      executeNotionExecution({
        prepared: fixture.prepared,
        client: firstClient,
        journal,
        mode: "apply",
      }),
    ).rejects.toThrow(/lost adoption acknowledgement/);
    expect(firstClient.mutationLog).toEqual([`adopt:${ADOPT_NOTION_ID}`]);
    expect(await fixture.store.readPage(pageId)).toMatchObject({
      markdown: before.markdown,
      meta: { title: before.meta.title },
    });

    const resumedClient = new StoreBackedBrainClient(fixture.store);
    await expect(
      executeNotionExecution({
        prepared: fixture.prepared,
        client: resumedClient,
        journal,
        mode: "apply",
      }),
    ).resolves.toMatchObject({ verified: 1 });
    expect(resumedClient.mutationLog).toEqual([]);
    expect(
      journal.records.some(
        (record) =>
          record.event.type === "page_adopted" &&
          record.event.recoveredAcknowledgement === true,
      ),
    ).toBe(true);
    await journal.close();
  });

  it.each(["wrong_notion", "placement"] as const)(
    "rejects legacy adoption %s drift before journal or mutation",
    async (drift) => {
      const fixture = await genericFixture(
        [
          {
            notionId: ADOPT_NOTION_ID,
            title: "Legacy",
            markdown: "legacy body",
            disposition: "adopt",
          },
        ],
        {
          candidateMetaByNotionId: new Map([
            [
              ADOPT_NOTION_ID,
              {
                notionId:
                  drift === "wrong_notion"
                    ? "9".repeat(32)
                    : ADOPT_NOTION_ID,
              },
            ],
          ]),
        },
      );
      if (drift === "placement") {
        await fixture.store.createPage(fixture.rootId, "Later sibling");
      }
      const client = new StoreBackedBrainClient(fixture.store);
      const { journal } = await temporaryJournal();
      await expect(
        executeNotionExecution({
          prepared: fixture.prepared,
          client,
          journal,
          mode: "apply",
        }),
      ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
      expect(journal.records).toHaveLength(0);
      expect(client.mutationLog).toHaveLength(0);
      await journal.close();
    },
  );

  it("keeps an exact legacy preserve anchor read-only", async () => {
    const fixture = await genericFixture(
      [
        {
          notionId: CREATE_NOTION_ID,
          title: "Created",
          markdown: "created body",
          disposition: "create",
        },
      ],
      {
        candidateMetaByNotionId: new Map([
          [ROOT_NOTION_ID, { notionId: ROOT_NOTION_ID }],
        ]),
      },
    );
    const rootRev = (await fixture.store.readPage(fixture.rootId)).rev;
    const client = new StoreBackedBrainClient(fixture.store);
    const { journal } = await temporaryJournal();
    await expect(
      executeNotionExecution({
        prepared: fixture.prepared,
        client,
        journal,
        mode: "apply",
      }),
    ).resolves.toMatchObject({ verified: 1 });
    expect((await fixture.store.readPage(fixture.rootId)).rev).toBe(rootRev);
    await expect(
      fixture.store.inspectNotionCandidate(fixture.rootId),
    ).resolves.toMatchObject({
      bindingState: "bound_untracked",
      notionId: ROOT_NOTION_ID,
      legacyBindingUpgradeable: true,
    });
    expect(client.mutationLog.some((event) => event.startsWith("adopt:"))).toBe(false);
    await journal.close();
  });

  it.each(["wrong_notion", "partial_tracking"] as const)(
    "rejects legacy preserve anchor with %s before journal or mutation",
    async (state) => {
      const fixture = await genericFixture(
        [
          {
            notionId: CREATE_NOTION_ID,
            title: "Created",
            markdown: "created body",
            disposition: "create",
          },
        ],
        {
          candidateMetaByNotionId: new Map([
            [
              ROOT_NOTION_ID,
              state === "wrong_notion"
                ? { notionId: "9".repeat(32) }
                : {
                    notionId: ROOT_NOTION_ID,
                    notionSourceHash: "e".repeat(64),
                  },
            ],
          ]),
        },
      );
      const client = new StoreBackedBrainClient(fixture.store);
      const { journal } = await temporaryJournal();
      await expect(
        executeNotionExecution({
          prepared: fixture.prepared,
          client,
          journal,
          mode: "apply",
        }),
      ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
      expect(journal.records).toHaveLength(0);
      expect(client.mutationLog).toHaveLength(0);
      await journal.close();
    },
  );

  it("rejects an unapplied adoption in verify mode before the journal opens", async () => {
    const fixture = await genericFixture([
      {
        notionId: ADOPT_NOTION_ID,
        title: "Adopted",
        markdown: "existing body",
        disposition: "adopt",
      },
    ]);
    const client = new StoreBackedBrainClient(fixture.store);
    const { journal } = await temporaryJournal();
    await expect(
      executeNotionExecution({
        prepared: fixture.prepared,
        client,
        journal,
        mode: "verify",
      }),
    ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
    expect(journal.records).toHaveLength(0);
    expect(client.mutationLog).toHaveLength(0);
    await journal.close();
  });

  it.each([
    "already_bound",
    "partial_untracked",
    "import_pending",
    "abort_pending",
    "tracked_drift",
  ] as const)(
    "rejects an adoption candidate with %s state before journal or executor mutation",
    async (state) => {
      const fixture = await genericFixture(
        [
          {
            notionId: ADOPT_NOTION_ID,
            title: "Adopted",
            markdown: "existing body",
            disposition: "adopt",
          },
        ],
        state === "partial_untracked"
          ? {
              candidateMetaByNotionId: new Map([
                [
                  ADOPT_NOTION_ID,
                  {
                    notionId: ADOPT_NOTION_ID,
                    notionSourceHash: "e".repeat(64),
                  },
                ],
              ]),
            }
          : {},
      );
      const pageId = fixture.candidateIds.get(ADOPT_NOTION_ID)!;
      const planPage = fixture.prepared.plan.pageByNotionId.get(ADOPT_NOTION_ID);
      if (!planPage) throw new Error("synthetic adoption page is missing");
      if (state !== "partial_untracked") {
        await adoptCandidateAs(
          fixture.store,
          pageId,
          state === "already_bound" ? "9".repeat(32) : ADOPT_NOTION_ID,
          planPage.sourceHash,
        );
      }
      if (state === "tracked_drift") {
        const tracked = await fixture.store.readPage(pageId);
        await fixture.store.writePage(
          pageId,
          "manual tracked edit",
          tracked.rev,
          "me",
        );
      } else if (state === "import_pending" || state === "abort_pending") {
        const candidate = await fixture.store.inspectNotionCandidate(pageId);
        const reserved = await fixture.store.reserveNotionImport({
          notionId: ADOPT_NOTION_ID,
          sourceHash: "e".repeat(64),
          parentId: candidate.current.parentId,
          beforeId: candidate.current.beforeId,
          title: "Adopted",
          reservationToken: "external_pending_token_0001",
        });
        if (state === "abort_pending") {
          if (reserved.status !== "reserved") {
            throw new Error("synthetic external reservation was not created");
          }
          await fixture.store.abortNotionImport({
            notionId: ADOPT_NOTION_ID,
            sourceHash: "e".repeat(64),
            reservationToken: reserved.reservationToken,
          });
        }
      }
      const client = new StoreBackedBrainClient(fixture.store);
      const { journal } = await temporaryJournal();
      await expect(
        executeNotionExecution({
          prepared: fixture.prepared,
          client,
          journal,
          mode: "apply",
        }),
      ).rejects.toMatchObject({ code: "candidate_baseline_drift" });
      expect(journal.records).toHaveLength(0);
      expect(client.mutationLog).toHaveLength(0);
      await journal.close();
    },
  );

  it("materializes typed page/collection/row metadata and stays idempotent", async () => {
    const notesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-typed-store-"));
    tempDirectories.push(notesRoot);
    const store = new Store(notesRoot);
    await store.init();
    const snapshot = await readNotionSnapshotV2Jsonl(typedSnapshotJson());
    const bindings = parseNotionBindingsJson(
      JSON.stringify({
        version: 1,
        snapshotFingerprint: snapshot.fingerprint,
        entries: snapshot.nodes.map((node) => ({
          notionId: node.notionId,
          disposition: "create",
        })),
      }),
    );
    const plan = buildGenericNotionImportPlan(snapshot, bindings, new Map(), {
      materializeNode: materializeGenericNotionSnapshotNode,
    });
    const prepared = prepareGenericNotionExecution(plan, new Map());
    const client = new StoreBackedBrainClient(store);
    const { journal } = await temporaryJournal();
    let token = 0;
    const tokenFactory = () => `typed_token_${String(++token).padStart(12, "0")}`;

    const first = await executeNotionExecution({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory,
    });
    expect(first).toMatchObject({ pages: 3, verified: 3 });
    const collectionStatus = await store.inspectNotionPage("7".repeat(32));
    const rowStatus = await store.inspectNotionPage("8".repeat(32));
    if (!collectionStatus || !rowStatus) throw new Error("typed pages are missing");
    const collection = await store.readPage(collectionStatus.id);
    const row = await store.readPage(rowStatus.id);
    expect(collection.meta.collection).toMatchObject({
      databaseId: "7".repeat(32),
      titlePropertyId: "title",
    });
    expect(row.meta).toMatchObject({
      title: "Untitled",
      collectionRow: {
        databaseId: "7".repeat(32),
        values: { title: { type: "title", value: "" } },
      },
    });

    const mutationCount = client.mutationLog.length;
    const journalCount = journal.records.length;
    const second = await executeNotionExecution({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory,
    });
    expect(second.remoteMutations).toEqual({
      reserves: 0,
      uploads: 0,
      finalizes: 0,
      aborts: 0,
    });
    expect(client.mutationLog).toHaveLength(mutationCount);
    expect(journal.records).toHaveLength(journalCount);

    const verified = await executeNotionExecution({
      prepared,
      client,
      journal,
      mode: "verify",
    });
    expect(verified.verified).toBe(3);
    expect(client.mutationLog).toHaveLength(mutationCount);
    expect(journal.records).toHaveLength(journalCount);
    await journal.close();
  });
});

class StoreBackedBrainClient implements BrainImportClient {
  readonly mutationLog: string[] = [];
  loseAdoptionAcknowledgement: number | undefined;
  #adoptions = 0;

  constructor(readonly store: Store) {}

  findPage(
    notionId: string,
    reservationToken?: string,
  ): Promise<NotionImportStatus | null> {
    return this.store.inspectNotionPage(notionId, reservationToken);
  }

  async inspectCandidate(
    pageId: string,
  ): Promise<NotionCandidateBaseline | null> {
    try {
      return await this.store.inspectNotionCandidate(pageId);
    } catch {
      return null;
    }
  }

  async adoptPage(
    input: AdoptNotionImportInput,
  ): Promise<AdoptNotionImportResult> {
    this.mutationLog.push(`adopt:${input.notionId}`);
    const result = await this.store.adoptNotionImport(input);
    this.#adoptions += 1;
    if (this.loseAdoptionAcknowledgement === this.#adoptions) {
      throw new Error("synthetic lost adoption acknowledgement");
    }
    return result;
  }

  reservePage(
    input: ReserveNotionImportInput,
  ): Promise<ReserveNotionImportResult> {
    this.mutationLog.push(
      `${input.conversionHash ? "reserve2" : "reserve1"}:${input.notionId}`,
    );
    return this.store.reserveNotionImport(input);
  }

  uploadAttachment(): Promise<SavedAttachment> {
    throw new Error("synthetic generic fixture has no attachments");
  }

  verifyAttachment(): Promise<VerifiedNotionAttachment> {
    throw new Error("synthetic generic fixture has no attachments");
  }

  verifyFinalizedAttachment(): Promise<VerifiedNotionAttachment> {
    throw new Error("synthetic generic fixture has no attachments");
  }

  finalizePage(
    input: FinalizeNotionImportInput,
  ): Promise<FinalizeNotionImportResult> {
    this.mutationLog.push(`finalize:${input.notionId}`);
    return this.store.finalizeNotionImport(input);
  }

  abortPage(input: AbortNotionImportInput): Promise<AbortNotionImportResult> {
    this.mutationLog.push(`abort:${input.notionId}`);
    return this.store.abortNotionImport(input);
  }

  async readPage(id: string): Promise<BrainReadPage> {
    return redactPage(await this.store.readPage(id)) as unknown as BrainReadPage;
  }
}

async function genericFixture(
  children: SourceChild[],
  options: GenericFixtureOptions = {},
): Promise<GenericFixture> {
  const notesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-generic-store-"));
  tempDirectories.push(notesRoot);
  let store = new Store(notesRoot);
  await store.init();
  const root = await store.createPage(null, "Field Guide", { markdown: "root body" });
  const candidateIds = new Map<string, string>([[ROOT_NOTION_ID, root.id]]);
  const expectedRevs = new Map<string, string>();
  for (const child of children) {
    if (child.disposition === "create") continue;
    const candidate = await store.createPage(root.id, child.title, {
      markdown: child.markdown,
    });
    candidateIds.set(child.notionId, candidate.id);
  }
  for (const [notionId, patch] of options.candidateMetaByNotionId ?? []) {
    const pageId = candidateIds.get(notionId);
    if (!pageId) throw new Error("synthetic candidate metadata target is missing");
    const page = await store.readPage(pageId);
    await fs.writeFile(
      path.join(store.resolve(pageId), "index.md"),
      serializePage({ ...page.meta, ...patch }, page.markdown),
    );
  }
  if ((options.candidateMetaByNotionId?.size ?? 0) > 0) {
    store = new Store(notesRoot);
    await store.init();
  }

  const snapshot = await readNotionSnapshotV2Jsonl(
    snapshotJson(children),
  );
  const rootRead = await store.readPage(root.id);
  const rootPlacement = findPlacement(store.getTree(), root.id);
  if (!rootPlacement) throw new Error("synthetic root placement is missing");
  expectedRevs.set(ROOT_NOTION_ID, rootRead.rev);
  const entries: unknown[] = [
    {
      notionId: ROOT_NOTION_ID,
      disposition: "preserve",
      brainPageId: root.id,
      expectedRev: rootRead.rev,
      expectedParentId: rootPlacement.parentId,
      expectedBeforeId: rootPlacement.beforeId,
    },
  ];
  for (const child of children) {
    if (child.disposition === "create") {
      entries.push({ notionId: child.notionId, disposition: "create" });
      continue;
    }
    const pageId = candidateIds.get(child.notionId)!;
    const read = await store.readPage(pageId);
    const placement = findPlacement(store.getTree(), pageId);
    if (!placement) throw new Error("synthetic candidate placement is missing");
    expectedRevs.set(child.notionId, read.rev);
    entries.push({
      notionId: child.notionId,
      disposition: child.disposition,
      brainPageId: pageId,
      expectedRev: read.rev,
      expectedParentId: placement.parentId,
      expectedBeforeId: placement.beforeId,
    });
  }
  const bindings = parseNotionBindingsJson(
    JSON.stringify({
      version: 1,
      snapshotFingerprint: snapshot.fingerprint,
      entries,
    }),
  );
  const plan = buildGenericNotionImportPlan(snapshot, bindings, new Map());
  return {
    store,
    rootId: root.id,
    candidateIds,
    expectedRevs,
    prepared: prepareGenericNotionExecution(plan, new Map()),
  };
}

function snapshotJson(children: SourceChild[]): string {
  const nodes = [
    {
      type: "node",
      kind: "page",
      notionId: ROOT_NOTION_ID,
      parentNotionId: null,
      position: 0,
      title: "Field Guide",
      enhancedMarkdown: "root body",
      assets: [],
    },
    ...children.map((child, position) => ({
      type: "node",
      kind: "page",
      notionId: child.notionId,
      parentNotionId: ROOT_NOTION_ID,
      position,
      title: child.title,
      enhancedMarkdown: child.markdown,
      assets: [],
    })),
  ];
  const records = [
    {
      type: "manifest",
      version: 2,
      source: "notion",
      rootNotionIds: [ROOT_NOTION_ID],
      counts: {
        nodes: nodes.length,
        pages: nodes.length,
        collections: 0,
        rows: 0,
        assets: 0,
        emptyBlocks: 0,
        hardBreaks: 0,
        externalLinks: 0,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    ...nodes,
    { type: "end", nodeCount: nodes.length, assetCount: 0 },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function typedSnapshotJson(): string {
  const rootId = "6".repeat(32);
  const collectionId = "7".repeat(32);
  const rowId = "8".repeat(32);
  const definition = {
    version: 1,
    source: "notion",
    databaseId: collectionId,
    dataSourceId: "9".repeat(32),
    titlePropertyId: "title",
    properties: [{ id: "title", name: "Name", position: 0, type: "title" }],
    views: [
      {
        id: "view",
        name: "Table",
        type: "table",
        rowNotionIds: [rowId],
        visiblePropertyIds: ["title"],
      },
    ],
    initialViewId: "view",
  };
  const nodes = [
    {
      type: "node",
      kind: "page",
      notionId: rootId,
      parentNotionId: null,
      position: 0,
      title: "Root",
      enhancedMarkdown: "Root body",
      assets: [],
    },
    {
      type: "node",
      kind: "collection",
      notionId: collectionId,
      parentNotionId: rootId,
      position: 0,
      title: "Words",
      enhancedMarkdown: "",
      assets: [],
      collection: definition,
    },
    {
      type: "node",
      kind: "row",
      notionId: rowId,
      parentNotionId: collectionId,
      position: 0,
      title: "Untitled",
      enhancedMarkdown: "",
      assets: [],
      collectionRow: {
        version: 1,
        source: "notion",
        databaseId: collectionId,
        values: { title: { type: "title", value: "" } },
      },
    },
  ];
  return [
    {
      type: "manifest",
      version: 2,
      source: "notion",
      rootNotionIds: [rootId],
      counts: {
        nodes: 3,
        pages: 1,
        collections: 1,
        rows: 1,
        assets: 0,
        emptyBlocks: 0,
        hardBreaks: 0,
        externalLinks: 0,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    ...nodes,
    { type: "end", nodeCount: 3, assetCount: 0 },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";
}

async function temporaryJournal(): Promise<{
  journal: PilotJournal;
  file: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brain-generic-journal-"));
  tempDirectories.push(directory);
  const file = path.join(directory, "generic.jsonl");
  return { journal: await PilotJournal.open(file), file };
}

function findPlacement(
  tree: TreeNode[],
  id: string,
  parentId: string | null = null,
): { parentId: string | null; beforeId: string | null } | undefined {
  for (const [index, node] of tree.entries()) {
    if (node.id === id) {
      return { parentId, beforeId: tree[index + 1]?.id ?? null };
    }
    const nested = findPlacement(node.children, id, node.id);
    if (nested) return nested;
  }
  return undefined;
}

function childTitles(tree: TreeNode[], parentId: string): string[] {
  const parent = findNode(tree, parentId);
  return parent?.children.map((child) => child.title) ?? [];
}

async function adoptCandidateAs(
  store: Store,
  pageId: string,
  notionId: string,
  sourceHash: string,
): Promise<void> {
  const read = await store.readPage(pageId);
  const placement = findPlacement(store.getTree(), pageId);
  if (!placement) throw new Error("synthetic candidate placement is missing");
  const conversionHash = notionConversionHash(
    canonicalizeNotionImportTarget({
      sourceHash,
      parentId: placement.parentId,
      beforeId: placement.beforeId,
      title: read.meta.title,
      icon: read.meta.icon,
      cover: read.meta.cover,
      markdown: read.markdown,
      collection: read.meta.collection,
      collectionRow: read.meta.collectionRow,
    }),
  );
  await store.adoptNotionImport({
    pageId,
    notionId,
    sourceHash,
    conversionHash,
    expectedRev: read.rev,
    expectedParentId: placement.parentId,
    expectedBeforeId: placement.beforeId,
  });
}

function findNode(tree: TreeNode[], id: string): TreeNode | undefined {
  for (const node of tree) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}
