import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { notionAttachmentUrl } from "../attachments";
import type {
  AbortNotionImportResult,
  AdoptNotionImportResult,
  FinalizeNotionImportInput,
  FinalizeNotionImportResult,
  NotionImportStatus,
  ReserveNotionImportInput,
  ReserveNotionImportResult,
  SavedAttachment,
  VerifiedNotionAttachment,
  VerifyFinalizedNotionAttachmentInput,
  VerifyNotionAttachmentInput,
} from "../store/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrainImportClient,
  BrainReadPage,
  UploadNotionAssetInput,
} from "./brain-mcp-client";
import {
  syntheticChannelSnapshot,
  syntheticResolvedAssets,
} from "./channel-fixture.test-helper";
import {
  executeChannelPilot,
  prepareChannelPilot,
  type PreparedChannelPilot,
} from "./executor";
import { PilotJournal } from "./journal";

const temporaryDirectories: string[] = [];

describe("Channel pilot executor", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("applies parent-first/reverse-sibling, verifies, and writes nothing on rerun", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal, file } = await temporaryJournal();
    let token = 0;
    client.onReserve = (input) => {
      expect(journal.latest("page_planned", input.notionId)).toBeDefined();
      expect(journal.latest("token_prepared", input.notionId)?.reservationToken)
        .toBe(input.reservationToken);
    };

    const first = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () => "synthetic_token_" + String(++token).padStart(4, "0"),
    });
    expect(first).toMatchObject({
      pages: 16,
      attachments: 3,
      remoteMutations: { reserves: 32, uploads: 3, finalizes: 16, aborts: 0 },
      verified: 16,
    });
    expect(client.passOne).toEqual(prepared.plan.pages.map((page) => page.notionId));
    expect(client.passTwo).toEqual(prepared.plan.pages.map((page) => page.notionId));
    expect(client.finalized).toEqual(
      prepared.plan.pages.map((page) => page.notionId),
    );
    expect(client.verifiedAttachments).toBe(3);
    expect(client.verifiedFinalizedAttachments).toBe(6);

    const mutationCounts = client.mutationCounts();
    const journalRecords = journal.records.length;
    const second = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () => "must_not_be_used_0000",
    });
    expect(second.remoteMutations).toEqual({
      reserves: 0,
      uploads: 0,
      finalizes: 0,
      aborts: 0,
    });
    expect(client.mutationCounts()).toEqual(mutationCounts);
    expect(journal.records).toHaveLength(journalRecords);

    const journalText = await fs.readFile(file, "utf8");
    expect(journalText).not.toContain('"markdown"');
    expect(journalText).not.toContain("https://");
    expect(journalText).not.toContain("dataBase64");
    await journal.close();
  });

  it.each(["missing", "corrupt"] as const)(
    "repairs a %s permanent attachment and returns to a zero-mutation rerun",
    async (damage) => {
      const prepared = await preparedPilot();
      const client = new FakeBrainClient();
      const { journal } = await temporaryJournal();
      let token = 0;
      const tokenFactory = () =>
        "repair_token_" + String(++token).padStart(7, "0");
      await executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory,
      });
      const damagedUrl = [...client.uploadedAssets.keys()][0];
      const damagedPage = [...client.pages.values()].find((page) =>
        page.markdown.includes(damagedUrl),
      );
      if (!damagedPage) throw new Error("synthetic attachment page missing");
      if (damage === "missing") {
        client.uploadedAssets.delete(damagedUrl);
      } else {
        const descriptor = client.uploadedAssets.get(damagedUrl);
        if (!descriptor) throw new Error("synthetic attachment missing");
        client.uploadedAssets.set(damagedUrl, {
          ...descriptor,
          sha256: "f".repeat(64),
        });
      }
      damagedPage.status.integrity = {
        trackedTargetIntact: true,
        trackedAttachmentIntact: false,
      };

      const repaired = await executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory,
      });
      expect(repaired.remoteMutations).toEqual({
        reserves: 2,
        uploads: 3,
        finalizes: 1,
        aborts: 0,
      });
      const afterRepair = client.mutationCounts();
      const stable = await executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory,
      });
      expect(stable.remoteMutations).toEqual({
        reserves: 0,
        uploads: 0,
        finalizes: 0,
        aborts: 0,
      });
      expect(client.mutationCounts()).toEqual(afterRepair);
      expect(
        journal.records.filter((record) => record.event.type === "run_started"),
      ).toHaveLength(2);
      expect(
        journal.records.filter(
          (record) => record.event.type === "capacity_reserved",
        ),
      ).toHaveLength(2);
      await journal.close();
    },
  );

  it("resumes after a lost finalize acknowledgement and verify mode stays read-only", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    client.failAfterDurableFinalize = 5;
    const { journal, file } = await temporaryJournal();
    let token = 0;
    await expect(
      executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory: () => "resume_token_" + String(++token).padStart(5, "0"),
      }),
    ).rejects.toThrow(/synthetic lost acknowledgement/);
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "indeterminate_failure",
      phase: "execution",
      cleanupAttempted: 0,
    });
    const reservedRecords = journal.records.filter(
      (record) => record.event.type === "page_reserved",
    ).length;
    const attachmentRecords = journal.records.filter(
      (record) => record.event.type === "attachment_saved",
    ).length;
    expect(reservedRecords).toBe(32);
    expect(attachmentRecords).toBe(3);
    await journal.close();

    const resumedJournal = await PilotJournal.open(file);
    const resumed = await executeChannelPilot({
      prepared,
      client,
      journal: resumedJournal,
      mode: "apply",
      tokenFactory: () => "resume_token_" + String(++token).padStart(5, "0"),
    });
    expect(resumed.verified).toBe(16);
    expect(client.pages.size).toBe(16);
    expect(
      resumedJournal.records.filter(
        (record) => record.event.type === "page_reserved",
      ),
    ).toHaveLength(reservedRecords);
    expect(
      resumedJournal.records.filter(
        (record) => record.event.type === "attachment_saved",
      ),
    ).toHaveLength(attachmentRecords);
    const beforeVerify = client.mutationCounts();
    const finalizedReadbacks = client.verifiedFinalizedAttachments;
    const verified = await executeChannelPilot({
      prepared,
      client,
      journal: resumedJournal,
      mode: "verify",
    });
    expect(verified.remoteMutations).toEqual({
      reserves: 0,
      uploads: 0,
      finalizes: 0,
      aborts: 0,
    });
    expect(client.mutationCounts()).toEqual(beforeVerify);
    expect(client.verifiedFinalizedAttachments).toBe(
      finalizedReadbacks + 3,
    );
    await resumedJournal.close();
  });

  it("reconciles a lost abort acknowledgement before reserve and counts it once", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal } = await temporaryJournal();
    const page = prepared.plan.pages[0];
    const reservationToken = "lost_abort_token_000001";
    await journal.append({
      type: "token_prepared",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      reservationToken,
    });
    const pendingStatus = status(
      "brain_" + page.notionId.slice(-12),
      page.notionId,
      null,
      null,
      page.sourceHash,
      false,
    );
    pendingStatus.pendingAbort = {
      pageId: pendingStatus.id,
      sourceHash: page.sourceHash,
      status: "detached",
      cleanup: {
        stagingRemoved: true,
        notionBindingRemoved: true,
        placeholderPreserved: true,
      },
    };
    pendingStatus.integrity = {
      abortBaselineIntact: true,
      reservationOwned: false,
    };
    client.pages.set(page.notionId, {
      status: pendingStatus,
      token: reservationToken,
      pendingParentId: null,
      pendingBeforeId: null,
      title: "Detached placeholder",
      markdown: "",
      rev: "abort-receipt",
    });

    let token = 0;
    const result = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () =>
        "post_abort_token_" + String(++token).padStart(5, "0"),
    });
    expect(result.remoteMutations.aborts).toBe(1);
    expect(client.aborted).toEqual([page.notionId]);
    const pageEvents = journal.records.filter(
      (record) => record.event.notionId === page.notionId,
    );
    const abortedSeq = pageEvents.find(
      (record) => record.event.type === "page_aborted",
    )?.seq;
    const reservedSeq = pageEvents.find(
      (record) => record.event.type === "page_reserved",
    )?.seq;
    expect(abortedSeq).toBeTypeOf("number");
    expect(reservedSeq).toBeGreaterThan(abortedSeq!);

    const stable = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
    });
    expect(stable.remoteMutations.aborts).toBe(0);
    expect(
      journal.records.filter(
        (record) =>
          record.event.type === "page_aborted" &&
          record.event.notionId === page.notionId,
      ),
    ).toHaveLength(1);
    await journal.close();
  });

  it("keeps a valid resumable chain when a visible journal append fails fsync", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brain-executor-fsync-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "pilot.jsonl");
    const realOpen = fs.open.bind(fs);
    let journalSyncs = 0;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === file) {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          journalSyncs += 1;
          if (journalSyncs === 2) {
            throw new Error("synthetic executor journal fsync failure");
          }
          return realSync();
        });
      }
      return handle;
    });
    const journal = await PilotJournal.open(file);
    try {
      await expect(
        executeChannelPilot({
          prepared,
          client,
          journal,
          mode: "apply",
          tokenFactory: () => "fsync_resume_token_0001",
        }),
      ).rejects.toThrow("synthetic executor journal fsync failure");
      expect(journal.latest("run_stopped")).toMatchObject({
        phase: "execution",
      });
    } finally {
      open.mockRestore();
      await journal.close();
    }

    const reopened = await PilotJournal.open(file);
    expect(reopened.records.map((record) => record.seq)).toEqual(
      reopened.records.map((_record, index) => index + 1),
    );
    const resumed = await executeChannelPilot({
      prepared,
      client,
      journal: reopened,
      mode: "apply",
      tokenFactory: (() => {
        let token = 0;
        return () => "fsync_resume_token_" + String(++token).padStart(4, "0");
      })(),
    });
    expect(resumed.verified).toBe(16);
    await reopened.close();
  });

  it("aborts every token-owned reservation leaf-first after a terminal upload failure", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    client.failUploadWithCode = "hash_mismatch";
    const { journal } = await temporaryJournal();
    let token = 0;
    await expect(
      executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory: () => "abort_token_" + String(++token).padStart(6, "0"),
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(client.aborted).toHaveLength(16);
    expect(client.pages.size).toBe(0);
    expect(journal.latest("page_aborted")).toMatchObject({
      status: "detached",
      stagingRemoved: true,
      notionBindingRemoved: true,
      placeholderPreserved: true,
    });
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "hash_mismatch",
      phase: "execution",
      cleanupAborted: 16,
      cleanupFailed: 0,
    });
    await journal.close();
  });

  it.each([
    "untracked_existing",
    "already_imported",
    "reservation_mismatch",
    "attachment_not_owned",
  ])(
    "cleans every pass-one reservation after deterministic %s conflict",
    async (code) => {
      const prepared = await preparedPilot();
      const client = new FakeBrainClient();
      client.failPassTwoWithCode = code;
      const { journal } = await temporaryJournal();
      let token = 0;

      await expect(
        executeChannelPilot({
          prepared,
          client,
          journal,
          mode: "apply",
          tokenFactory: () =>
            "conflict_token_" + String(++token).padStart(5, "0"),
        }),
      ).rejects.toMatchObject({ code });
      expect(client.passOne).toHaveLength(16);
      expect(client.aborted).toHaveLength(16);
      expect(client.pages.size).toBe(0);
      expect(journal.latest("run_stopped")).toMatchObject({
        code,
        phase: "execution",
        cleanupAttempted: 16,
        cleanupAborted: 16,
        cleanupFailed: 0,
      });
      await journal.close();
    },
  );

  it("finishes the destination preflight before mutation and stops on baseline drift", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal } = await temporaryJournal();
    let token = 0;
    await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () => "drift_token_" + String(++token).padStart(6, "0"),
    });
    const last = client.pages.get(prepared.plan.pages.at(-1)!.notionId);
    if (!last) throw new Error("synthetic destination page missing");
    last.status.integrity = { trackedTargetIntact: false };
    const before = client.mutationCounts();
    client.findCalls = 0;

    await expect(
      executeChannelPilot({ prepared, client, journal, mode: "apply" }),
    ).rejects.toMatchObject({ code: "destination_drift" });
    expect(client.findCalls).toBe(16);
    expect(client.mutationCounts()).toEqual(before);
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "destination_drift",
      phase: "preflight",
      cleanupAttempted: 0,
    });
    await journal.close();
  });

  it("preflights deleted, unowned-busy, and duplicate mappings without writes", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal } = await temporaryJournal();
    let token = 0;
    await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () => "guard_token_" + String(++token).padStart(6, "0"),
    });
    const lastId = prepared.plan.pages.at(-1)!.notionId;
    const previousId = prepared.plan.pages.at(-2)!.notionId;
    const last = client.pages.get(lastId);
    const previous = client.pages.get(previousId);
    if (!last || !previous) throw new Error("synthetic destination page missing");
    const before = client.mutationCounts();

    last.status.deleted = true;
    await expect(
      executeChannelPilot({ prepared, client, journal, mode: "apply" }),
    ).rejects.toMatchObject({ code: "destination_deleted" });
    last.status.deleted = false;

    last.status.importing = {
      sourceHash: "f".repeat(64),
      started: "synthetic",
      leaseFresh: true,
      retryAfterMs: 1_000,
    };
    last.status.integrity = { importBaselineIntact: true };
    await expect(
      executeChannelPilot({ prepared, client, journal, mode: "apply" }),
    ).rejects.toMatchObject({ code: "destination_busy" });
    delete last.status.importing;
    last.status.integrity = { trackedTargetIntact: true };

    const originalBrainId = last.status.id;
    last.status.id = previous.status.id;
    await expect(
      executeChannelPilot({ prepared, client, journal, mode: "apply" }),
    ).rejects.toMatchObject({ code: "destination_mapping_conflict" });
    last.status.id = originalBrainId;

    expect(client.mutationCounts()).toEqual(before);
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "destination_mapping_conflict",
      phase: "preflight",
      cleanupAttempted: 0,
    });
    await journal.close();
  });

  it.each(["same-source", "changed-source"] as const)(
    "takes over an intact stale %s reservation",
    async (kind) => {
      const prepared = await preparedPilot();
      const client = new FakeBrainClient();
      const { journal } = await temporaryJournal();
      const page = prepared.plan.pages[0];
      const candidateToken = "stale_candidate_token_001";
      await journal.append({
        type: "token_prepared",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        reservationToken: candidateToken,
      });
      const staleStatus = status(
        "brain_" + page.notionId.slice(-12),
        page.notionId,
        null,
        null,
        kind === "same-source" ? page.sourceHash : "f".repeat(64),
        true,
      );
      if (!staleStatus.importing) throw new Error("expected importing status");
      staleStatus.importing.leaseFresh = false;
      staleStatus.importing.retryAfterMs = 0;
      staleStatus.integrity = { importBaselineIntact: true };
      client.pages.set(page.notionId, {
        status: staleStatus,
        token:
          kind === "same-source"
            ? candidateToken
            : "previous_stale_owner_0001",
        pendingParentId: null,
        pendingBeforeId: null,
        title: staleStatus.title,
        markdown: "",
        rev: "stale",
      });
      let token = 0;
      const result = await executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory: () =>
          "stale_takeover_" + String(++token).padStart(7, "0"),
      });
      expect(result.verified).toBe(prepared.plan.pages.length);
      expect(client.pages).toHaveLength(prepared.plan.pages.length);
      await journal.close();
    },
  );

  it("preflights a fresh same-source reservation with the wrong token without writes", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal } = await temporaryJournal();
    const page = prepared.plan.pages[0];
    await journal.append({
      type: "token_prepared",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      reservationToken: "wrong_fresh_candidate_001",
    });
    const freshStatus = status(
      "brain_" + page.notionId.slice(-12),
      page.notionId,
      null,
      null,
      page.sourceHash,
      true,
    );
    client.pages.set(page.notionId, {
      status: freshStatus,
      token: "actual_fresh_owner_token_01",
      pendingParentId: null,
      pendingBeforeId: null,
      title: freshStatus.title,
      markdown: "",
      rev: "fresh",
    });
    const before = client.mutationCounts();
    await expect(
      executeChannelPilot({ prepared, client, journal, mode: "apply" }),
    ).rejects.toMatchObject({ code: "destination_busy" });
    expect(client.mutationCounts()).toEqual(before);
    expect(client.pages.get(page.notionId)?.token).toBe(
      "actual_fresh_owner_token_01",
    );
    await journal.close();
  });

  it("preserves the primary terminal error when one cleanup abort fails", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    client.failUploadWithCode = "hash_mismatch";
    client.failAbortNotionId = prepared.plan.pages[0].notionId;
    const { journal } = await temporaryJournal();
    let token = 0;
    await expect(
      executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory: () =>
          "cleanup_token_" + String(++token).padStart(5, "0"),
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(journal.latest("page_abort_failed")).toMatchObject({
      notionId: client.failAbortNotionId,
      code: "synthetic_abort_failure",
    });
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "hash_mismatch",
      cleanupAborted: 15,
      cleanupFailed: 1,
    });
    await journal.close();
  });

  it("stops on mismatched permanent attachment read-back after finalize", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    client.corruptFinalizedReadback = true;
    const { journal } = await temporaryJournal();
    let token = 0;
    await expect(
      executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory: () =>
          "permanent_token_" + String(++token).padStart(4, "0"),
      }),
    ).rejects.toMatchObject({
      code: "finalized_attachment_readback_mismatch",
    });
    expect(client.finalized).toHaveLength(2);
    expect(client.pages.size).toBe(2);
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "finalized_attachment_readback_mismatch",
      cleanupAborted: 14,
      cleanupFailed: 0,
    });
    await journal.close();
  });

  it("retries only explicit busy responses with the same leaf identity", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    client.busyOnceNotionId = prepared.plan.pages[0].notionId;
    client.uploadBusyRemaining = 1;
    const delays: number[] = [];
    const { journal } = await temporaryJournal();
    let token = 0;
    const result = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory: () => "retry_token_" + String(++token).padStart(6, "0"),
      retry: {
        maxAttempts: 3,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    });

    expect(result.verified).toBe(16);
    expect(result.remoteMutations).toMatchObject({
      reserves: 33,
      uploads: 4,
    });
    expect(delays).toEqual([250, 750]);
    expect(client.pages.size).toBe(16);
    expect(new Set(client.pages.keys()).size).toBe(16);
    await journal.close();
  });

  it("rolls a stopped exhausted run only after preflight and resumes through abort acknowledgements", async () => {
    const prepared = await preparedPilot();
    const client = new FakeBrainClient();
    const { journal } = await temporaryJournal();
    client.failUploadWithCode = "hash_mismatch";
    let padding = 0;
    client.beforeUploadFailure = async () => {
      client.failUploadWithCode = undefined;
      for (;;) {
        try {
          journal.assertRemoteMutationCapacity("normal");
        } catch (error) {
          expect(error).toMatchObject({ code: "journal_capacity" });
          break;
        }
        await journal.append({
          type: "padding",
          ordinal: padding,
          value: "x".repeat(4096),
        });
        padding += 1;
      }
    };
    let token = 0;
    const tokenFactory = () =>
      "rollover_token_" + String(++token).padStart(5, "0");

    await expect(
      executeChannelPilot({
        prepared,
        client,
        journal,
        mode: "apply",
        tokenFactory,
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "hash_mismatch",
      cleanupAborted: prepared.plan.pages.length,
      cleanupFailed: 0,
    });
    expect(
      journal.records.filter((record) => record.event.type === "page_aborted"),
    ).toHaveLength(prepared.plan.pages.length);
    expect(() => journal.assertRemoteMutationCapacity("normal")).toThrow(
      /no safe capacity/,
    );
    expect(() => journal.assertRemoteMutationCapacity("cleanup")).not.toThrow();
    const tokenRecords = journal.records.filter(
      (record) => record.event.type === "token_prepared",
    ).length;
    const mutationsBeforeCapacityBlock = client.mutationCounts();
    const runStartsBeforeCapacityBlock = journal.records.filter(
      (record) => record.event.type === "run_started",
    ).length;
    const capacityBlock = vi
      .spyOn(journal, "assertNewRemoteRunCapacity")
      .mockImplementation(() => {
        throw Object.assign(new Error("synthetic global journal limit"), {
          code: "journal_capacity",
        });
      });
    try {
      await expect(
        executeChannelPilot({
          prepared,
          client,
          journal,
          mode: "apply",
          tokenFactory,
        }),
      ).rejects.toMatchObject({ code: "journal_capacity" });
    } finally {
      capacityBlock.mockRestore();
    }
    expect(client.mutationCounts()).toEqual(mutationsBeforeCapacityBlock);
    expect(
      journal.records.filter((record) => record.event.type === "run_started"),
    ).toHaveLength(runStartsBeforeCapacityBlock);
    expect(journal.latest("run_stopped")).toMatchObject({
      code: "journal_capacity",
      cleanupAttempted: 0,
      cleanupAborted: 0,
    });
    const findCallsBeforeRestart = client.findCalls;
    let findCallsAtFirstRestartMutation: number | undefined;
    client.onReserve = () => {
      findCallsAtFirstRestartMutation ??= client.findCalls;
    };

    const resumed = await executeChannelPilot({
      prepared,
      client,
      journal,
      mode: "apply",
      tokenFactory,
    });
    expect(resumed).toMatchObject({
      verified: prepared.plan.pages.length,
      remoteMutations: {
        reserves: prepared.plan.pages.length * 2,
        uploads: prepared.plan.counts.assets,
        finalizes: prepared.plan.pages.length,
        aborts: 0,
      },
    });
    expect(findCallsAtFirstRestartMutation).toBeGreaterThanOrEqual(
      findCallsBeforeRestart + prepared.plan.pages.length * 2,
    );
    expect(client.acknowledgedAborts).toHaveLength(prepared.plan.pages.length);
    expect(client.abortedReceipts.size).toBe(0);
    expect(client.pages.size).toBe(prepared.plan.pages.length);
    expect(
      journal.records.filter((record) => record.event.type === "token_prepared"),
    ).toHaveLength(tokenRecords);

    const lifecycle = journal.records
      .filter((record) =>
        ["run_started", "capacity_reserved", "run_stopped", "run_completed"].includes(
          record.event.type,
        ),
      )
      .map((record) => record.event.type);
    expect(lifecycle).toEqual([
      "run_started",
      "capacity_reserved",
      "run_stopped",
      "run_stopped",
      "run_started",
      "capacity_reserved",
      "run_completed",
    ]);
    await journal.close();
  }, 20_000);

  it.each(["reserve", "upload", "finalize", "abort"] as const)(
    "checks durable journal capacity before every remote %s mutation",
    async (phase) => {
      const prepared = await preparedPilot();
      const client = new FakeBrainClient();
      if (phase === "abort") client.failUploadWithCode = "hash_mismatch";
      const { journal } = await temporaryJournal();
      let normalCalls = 0;
      const capacity = vi
        .spyOn(journal, "assertRemoteMutationCapacity")
        .mockImplementation((kind) => {
          if (kind === "normal") normalCalls += 1;
          const exhausted =
            (phase === "reserve" && kind === "normal" && normalCalls === 1) ||
            (phase === "upload" && kind === "normal" && normalCalls === 33) ||
            (phase === "finalize" && kind === "normal" && normalCalls === 36) ||
            (phase === "abort" && kind === "cleanup");
          if (exhausted) {
            throw Object.assign(new Error("synthetic journal capacity"), {
              code: "journal_capacity",
            });
          }
        });
      let token = 0;
      try {
        await expect(
          executeChannelPilot({
            prepared,
            client,
            journal,
            mode: "apply",
            tokenFactory: () =>
              "capacity_token_" + String(++token).padStart(6, "0"),
          }),
        ).rejects.toMatchObject({
          code: phase === "abort" ? "hash_mismatch" : "journal_capacity",
        });
      } finally {
        capacity.mockRestore();
      }
      const mutations = client.mutationCounts();
      if (phase === "reserve") expect(mutations.reserves).toBe(0);
      if (phase === "upload") expect(mutations.uploads).toBe(0);
      if (phase === "finalize") expect(mutations.finalizes).toBe(0);
      if (phase === "abort") expect(mutations.aborts).toBe(0);
      await journal.close();
    },
  );
});

async function preparedPilot(): Promise<PreparedChannelPilot> {
  const received = await syntheticChannelSnapshot("received");
  const fresh = await syntheticChannelSnapshot("fresh");
  return prepareChannelPilot(
    received,
    fresh,
    syntheticResolvedAssets(received),
  );
}

async function temporaryJournal() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brain-executor-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "pilot.jsonl");
  return { journal: await PilotJournal.open(file), file };
}

interface FakePage {
  status: NotionImportStatus;
  token?: string;
  pendingConversionHash?: string;
  pendingParentId: string | null;
  pendingBeforeId: string | null;
  title: string;
  icon?: string;
  cover?: string;
  markdown: string;
  rev: string;
}

class FakeBrainClient implements BrainImportClient {
  pages = new Map<string, FakePage>();
  passOne: string[] = [];
  passTwo: string[] = [];
  uploaded: string[] = [];
  uploadedAssets = new Map<string, VerifiedNotionAttachment>();
  abortedReceipts = new Map<
    string,
    { sourceHash: string; reservationToken: string }
  >();
  finalized: string[] = [];
  aborted: string[] = [];
  acknowledgedAborts: string[] = [];
  onReserve?: (input: ReserveNotionImportInput) => void;
  beforeUploadFailure?: () => Promise<void>;
  failAfterDurableFinalize?: number;
  failUploadWithCode?: string;
  failPassTwoWithCode?: string;
  failAbortNotionId?: string;
  uploadBusyRemaining = 0;
  busyOnceNotionId?: string;
  busyReturned = false;
  verifiedAttachments = 0;
  verifiedFinalizedAttachments = 0;
  corruptFinalizedReadback = false;
  findCalls = 0;
  #lostAcknowledgement = false;

  mutationCounts() {
    return {
      reserves: this.passOne.length + this.passTwo.length,
      uploads: this.uploaded.length,
      finalizes: this.finalized.length,
      aborts: this.aborted.length,
    };
  }

  async findPage(
    notionId: string,
    reservationToken?: string,
  ): Promise<NotionImportStatus | null> {
    this.findCalls += 1;
    const page = this.pages.get(notionId);
    if (!page) return null;
    const result = cloneStatus(page.status);
    if (result.importing || result.pendingAbort) {
      result.integrity = {
        ...result.integrity,
        reservationOwned: reservationToken === page.token,
      };
    }
    return result;
  }

  async inspectCandidate(): Promise<null> {
    throw new Error("synthetic candidate inspection is outside Channel v1");
  }

  async adoptPage(): Promise<AdoptNotionImportResult> {
    throw new Error("synthetic adoption is outside the Channel executor");
  }

  async reservePage(
    input: ReserveNotionImportInput,
  ): Promise<ReserveNotionImportResult> {
    this.onReserve?.(input);
    (input.conversionHash ? this.passTwo : this.passOne).push(input.notionId);
    const abortReceipt = this.abortedReceipts.get(input.notionId);
    if (abortReceipt) {
      if (
        input.acknowledgedAbort?.sourceHash !== abortReceipt.sourceHash ||
        input.acknowledgedAbort.reservationToken !==
          abortReceipt.reservationToken
      ) {
        throw Object.assign(new Error("synthetic abort acknowledgement required"), {
          code: "abort_ack_required",
        });
      }
      this.acknowledgedAborts.push(input.notionId);
      this.abortedReceipts.delete(input.notionId);
    }
    if (input.conversionHash && this.failPassTwoWithCode) {
      throw Object.assign(new Error("synthetic deterministic pass-two conflict"), {
        code: this.failPassTwoWithCode,
      });
    }
    if (input.notionId === this.busyOnceNotionId && !this.busyReturned) {
      this.busyReturned = true;
      return {
        status: "busy",
        page: status(
          "busy_" + input.notionId.slice(-12),
          input.notionId,
          input.parentId,
          input.beforeId,
          input.sourceHash,
          true,
        ),
        retryAfterMs: 250,
      };
    }
    let page = this.pages.get(input.notionId);
    if (!page) {
      page = {
        status: status(
          "brain_" + input.notionId.slice(-12),
          input.notionId,
          input.parentId,
          input.beforeId,
          input.sourceHash,
          true,
        ),
        token: input.reservationToken,
        pendingParentId: input.parentId,
        pendingBeforeId: input.beforeId,
        title: input.title,
        icon: input.icon,
        cover: input.cover,
        markdown: "",
        rev: "placeholder",
      };
      this.pages.set(input.notionId, page);
    } else if (
      !page.status.importing &&
      page.status.sourceHash === input.sourceHash &&
      !input.conversionHash
    ) {
      return { status: "conversion_required", page: cloneStatus(page.status) };
    } else if (
      !page.status.importing &&
      page.status.sourceHash === input.sourceHash &&
      page.status.conversionHash === input.conversionHash &&
      page.status.current.parentId === input.parentId &&
      page.status.current.beforeId === input.beforeId &&
      page.status.integrity?.trackedAttachmentIntact !== false
    ) {
      return { status: "unchanged", page: cloneStatus(page.status) };
    } else if (
      page.status.importing &&
      page.status.importing.leaseFresh &&
      page.token !== input.reservationToken
    ) {
      return {
        status: "busy",
        page: cloneStatus(page.status),
        retryAfterMs: 1000,
      };
    } else {
      page.token = input.reservationToken;
      page.status.importing = {
        sourceHash: input.sourceHash,
        started: "synthetic",
        leaseFresh: true,
        retryAfterMs: 1_000,
      };
    }
    page.pendingConversionHash = input.conversionHash;
    page.pendingParentId = input.parentId;
    page.pendingBeforeId = input.beforeId;
    page.title = input.title;
    page.icon = input.icon || undefined;
    page.cover = input.cover || undefined;
    page.status.title = input.title;
    page.status.icon = page.icon;
    return {
      status: "reserved",
      page: cloneStatus(page.status),
      reservationToken: input.reservationToken,
      created: page.markdown === "",
    };
  }

  async uploadAttachment(
    input: UploadNotionAssetInput,
  ): Promise<SavedAttachment> {
    const page = this.pages.get(input.notionId);
    if (!page || page.token !== input.reservationToken) {
      throw new Error("synthetic reservation mismatch");
    }
    const failureCode = this.failUploadWithCode;
    if (failureCode) {
      await this.beforeUploadFailure?.();
      throw Object.assign(new Error("synthetic terminal upload failure"), {
        code: failureCode,
      });
    }
    if (this.uploadBusyRemaining > 0) {
      this.uploadBusyRemaining -= 1;
      throw Object.assign(new Error("synthetic upload busy"), {
        code: "upload_busy",
        retryAfterMs: 750,
      });
    }
    this.uploaded.push(input.asset.sourceId);
    const saved = {
      url: notionAttachmentUrl(
        input.asset.sha256,
        input.asset.name,
        input.asset.mimeType,
      ),
      name: input.asset.name,
      size: input.asset.bytes.byteLength,
      type: input.asset.mimeType,
    };
    this.uploadedAssets.set(saved.url, {
      url: saved.url,
      size: saved.size,
      sha256: input.asset.sha256,
    });
    return saved;
  }

  async verifyAttachment(
    input: VerifyNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    const page = this.pages.get(input.notionId);
    if (!page || page.token !== input.reservationToken) {
      throw new Error("synthetic reservation mismatch");
    }
    const verified = this.uploadedAssets.get(input.url);
    if (!verified) throw new Error("synthetic uploaded attachment missing");
    this.verifiedAttachments += 1;
    return structuredClone(verified);
  }

  async verifyFinalizedAttachment(
    input: VerifyFinalizedNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    const page = this.pages.get(input.notionId);
    if (
      !page ||
      page.status.importing ||
      page.status.sourceHash !== input.sourceHash ||
      page.status.conversionHash !== input.conversionHash ||
      (page.cover !== input.url && !page.markdown.includes(input.url))
    ) {
      throw Object.assign(new Error("synthetic finalized attachment mismatch"), {
        code: "attachment_not_owned",
      });
    }
    const verified = this.uploadedAssets.get(input.url);
    if (!verified) throw new Error("synthetic permanent attachment missing");
    this.verifiedFinalizedAttachments += 1;
    if (this.corruptFinalizedReadback) {
      this.corruptFinalizedReadback = false;
      return { ...structuredClone(verified), sha256: "f".repeat(64) };
    }
    return structuredClone(verified);
  }

  async finalizePage(
    input: FinalizeNotionImportInput,
  ): Promise<FinalizeNotionImportResult> {
    const page = this.pages.get(input.notionId);
    if (!page || page.token !== input.reservationToken) {
      throw new Error("synthetic reservation mismatch");
    }
    page.status.sourceHash = input.sourceHash;
    page.status.conversionHash = input.conversionHash;
    page.status.current = {
      parentId: page.pendingParentId,
      beforeId: page.pendingBeforeId,
    };
    page.status.trackedBaseline = {
      ...page.status.current,
      order: "synthetic-order-" + input.notionId,
    };
    page.status.integrity = {
      trackedTargetIntact: true,
      trackedAttachmentIntact: true,
    };
    delete page.status.importing;
    page.markdown = input.markdown;
    page.title = input.title ?? page.title;
    page.icon = input.icon || undefined;
    page.cover = input.cover || undefined;
    page.status.title = page.title;
    page.status.icon = page.icon;
    page.rev = "rev_" + String(this.finalized.length + 1);
    this.finalized.push(input.notionId);
    const result: FinalizeNotionImportResult = {
      status: "finalized",
      page: cloneStatus(page.status),
      rev: page.rev,
      cleanup: { stagingRemoved: true },
    };
    if (
      this.failAfterDurableFinalize === this.finalized.length &&
      !this.#lostAcknowledgement
    ) {
      this.#lostAcknowledgement = true;
      throw new Error("synthetic lost acknowledgement");
    }
    return result;
  }

  async abortPage(input: {
    notionId: string;
    sourceHash: string;
    reservationToken: string;
  }): Promise<AbortNotionImportResult> {
    const page = this.pages.get(input.notionId);
    if (!page || page.token !== input.reservationToken) {
      throw new Error("synthetic reservation mismatch");
    }
    if (input.notionId === this.failAbortNotionId) {
      throw Object.assign(new Error("synthetic abort failure"), {
        code: "synthetic_abort_failure",
      });
    }
    if (
      [...this.pages.values()].some(
        (candidate) => candidate.pendingParentId === page.status.id,
      )
    ) {
      throw Object.assign(new Error("synthetic parent still has import children"), {
        code: "has_import_children",
      });
    }
    this.aborted.push(input.notionId);
    this.abortedReceipts.set(input.notionId, {
      sourceHash: input.sourceHash,
      reservationToken: input.reservationToken,
    });
    this.pages.delete(input.notionId);
    return {
      status: "detached" as const,
      pageId: page.status.id,
      cleanup: {
        stagingRemoved: true,
        notionBindingRemoved: true,
        placeholderPreserved: true,
      },
    };
  }

  async readPage(id: string): Promise<BrainReadPage> {
    const page = [...this.pages.values()].find((candidate) => candidate.status.id === id);
    if (!page) throw new Error("synthetic page missing");
    return {
      meta: {
        id,
        title: page.title,
        order: page.status.trackedBaseline?.order ?? "synthetic-order",
        icon: page.icon,
        cover: page.cover,
        notionId:
          page.status.pendingAbort?.status === "detached"
            ? undefined
            : page.status.notionId,
        notionSourceHash: page.status.sourceHash,
        notionConversionHash: page.status.conversionHash,
        notionTargetRev: page.status.sourceHash ? "synthetic-target-rev" : undefined,
        notionTargetParentId: page.status.trackedBaseline?.parentId,
        notionTargetBeforeId: page.status.trackedBaseline?.beforeId,
        notionTargetOrder: page.status.trackedBaseline?.order,
      },
      markdown: page.markdown,
      rev: page.rev,
    };
  }
}

function status(
  id: string,
  notionId: string,
  parentId: string | null,
  beforeId: string | null,
  sourceHash: string,
  importing: boolean,
): NotionImportStatus {
  return {
    id,
    title: "Synthetic",
    notionId,
    current: { parentId, beforeId },
    importing: importing
      ? {
          sourceHash,
          started: "synthetic",
          leaseFresh: true,
          retryAfterMs: 1_000,
        }
      : undefined,
    integrity: importing
      ? { importBaselineIntact: true }
      : { trackedTargetIntact: true, trackedAttachmentIntact: true },
    deleted: false,
  };
}

function cloneStatus(value: NotionImportStatus): NotionImportStatus;
function cloneStatus(value: null): null;
function cloneStatus(value: NotionImportStatus | null): NotionImportStatus | null;
function cloneStatus(value: NotionImportStatus | null): NotionImportStatus | null {
  return value ? structuredClone(value) : null;
}
