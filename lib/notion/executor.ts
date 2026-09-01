import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { notionAttachmentUrl } from "../attachments.ts";
import type {
  CollectionDefinition,
  CollectionRow,
} from "../collections/model.ts";
import type {
  NotionCandidateBaseline,
  NotionImportStatus,
  ReserveNotionImportInput,
} from "../store/types.ts";
import type { BrainImportClient } from "./brain-mcp-client.ts";
import type {
  NotionAdoptBinding,
  NotionPreserveBinding,
} from "./bindings.ts";
import {
  assertNotionConversionReady,
  conversionHashForNotionDocument,
  convertNotionDocumentWithIssues,
} from "./converter.ts";
import type { PilotJournal, PilotJournalEvent } from "./journal.ts";
import type { ResolvedNotionAsset } from "./notion-assets.ts";
import type {
  NotionExecutionPage,
  NotionExecutionPlan,
} from "./execution-plan.ts";
import {
  buildChannelPilotPlan,
  freezeChannelSnapshot,
  type ChannelPilotPlan,
} from "./plan.ts";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
  NOTION_CONVERTER_VERSION,
} from "./protocol.ts";
import type { NotionSnapshot } from "./snapshot.ts";

export interface PreparedNotionExecution {
  plan: NotionExecutionPlan;
  assets: ReadonlyMap<string, ResolvedNotionAsset>;
}

export interface PreparedChannelPilot extends PreparedNotionExecution {
  snapshot: NotionSnapshot;
  plan: ChannelPilotPlan;
}

export interface ExecuteNotionExecutionOptions {
  prepared: PreparedNotionExecution;
  client: BrainImportClient;
  journal: PilotJournal;
  mode: "apply" | "verify";
  tokenFactory?: () => string;
  retry?: {
    maxAttempts?: number;
    sleep?: (delayMs: number) => Promise<void>;
  };
}

export interface PreflightNotionExecutionOptions {
  prepared: PreparedNotionExecution;
  client: BrainImportClient;
  mode: "apply" | "verify";
}

export interface PreflightNotionExecutionResult {
  mode: "apply" | "verify";
  pages: number;
  fixedPages: number;
  adoptions: number;
}

export interface ExecuteChannelPilotOptions extends ExecuteNotionExecutionOptions {
  prepared: PreparedChannelPilot;
}

export interface ExecuteNotionExecutionResult {
  mode: "apply" | "verify";
  pages: number;
  attachments: number;
  remoteMutations: {
    reserves: number;
    uploads: number;
    finalizes: number;
    aborts: number;
  };
  verified: number;
}

export type ExecuteChannelPilotResult = ExecuteNotionExecutionResult;

interface DesiredPage {
  parentId: string | null;
  beforeId: string | null;
  conversionHash: string;
  markdown: string;
  cover?: string;
  collection?: CollectionDefinition | null;
  collectionRow?: CollectionRow | null;
  attachments: ReadonlyMap<
    string,
    { url: string; sha256: string; size: number }
  >;
}

interface RemoteRunContext {
  runId: string;
  completed: boolean;
  stopped: boolean;
  capacityReady: boolean;
}

interface NotionPreflightOptions {
  prepared: PreparedNotionExecution;
  client: BrainImportClient;
  mode: "apply" | "verify";
  journal: Pick<PilotJournal, "latest">;
}

interface GenericV2ExecutionPage extends NotionExecutionPage {
  disposition: "create" | "adopt";
  brainPageId?: string;
}

interface GenericV2ExecutionPlan
  extends NotionExecutionPlan<GenericV2ExecutionPage> {
  version: 2;
  fixedPageIds: ReadonlyMap<string, string>;
  preservedBindings: readonly NotionPreserveBinding[];
  adoptionBindings: readonly NotionAdoptBinding[];
}

interface GenericAdoptionBaseline {
  binding: NotionAdoptBinding;
  page: GenericV2ExecutionPage;
  candidate: NotionCandidateBaseline;
  sourceHash: string;
  conversionHash: string;
  alreadyTracked: boolean;
  legacyBound: boolean;
}

interface GenericBaselinePreflight {
  plan: GenericV2ExecutionPlan;
  adoptions: GenericAdoptionBaseline[];
}

export function prepareChannelPilot(
  received: NotionSnapshot,
  fresh: NotionSnapshot,
  assets: ReadonlyMap<string, ResolvedNotionAsset>,
): PreparedChannelPilot {
  const snapshot = freezeChannelSnapshot(received, fresh);
  return {
    snapshot,
    plan: buildChannelPilotPlan(snapshot, assets),
    assets,
  };
}

export function notionPilotErrorCode(error: unknown): string | undefined {
  const code = errorCode(error);
  return code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export async function executeChannelPilot(
  options: ExecuteChannelPilotOptions,
): Promise<ExecuteChannelPilotResult> {
  return executeNotionExecution(options);
}

/**
 * Run the complete read-only destination gate without opening or creating a
 * journal. The mutating executor intentionally repeats this gate immediately
 * before apply so a successful operator preflight cannot weaken its TOCTOU
 * protections.
 */
export async function preflightNotionExecution(
  options: PreflightNotionExecutionOptions,
): Promise<PreflightNotionExecutionResult> {
  const plan = genericExecutionPlan(options.prepared.plan);
  const readOnlyOptions: NotionPreflightOptions = {
    ...options,
    journal: { latest: () => undefined },
  };
  const baseline = plan
    ? await preflightGenericCandidates(readOnlyOptions, plan)
    : undefined;
  await preflightDestination(
    readOnlyOptions,
    new Map(
      baseline?.adoptions
        .filter((adoption) => adoption.legacyBound)
        .map((adoption) => [
          adoption.binding.notionId,
          adoption.binding.brainPageId,
        ]) ?? [],
    ),
  );
  return {
    mode: options.mode,
    pages: options.prepared.plan.pages.length,
    fixedPages: plan?.fixedPageIds.size ?? 0,
    adoptions: baseline?.adoptions.length ?? 0,
  };
}

export async function executeNotionExecution(
  options: ExecuteNotionExecutionOptions,
): Promise<ExecuteNotionExecutionResult> {
  const { plan } = options.prepared;
  const genericPlan = genericExecutionPlan(plan);
  const genericBaseline = genericPlan
    ? await preflightGenericCandidates(options, genericPlan)
    : undefined;
  if (genericBaseline) {
    await preflightDestination(
      options,
      new Map(
        genericBaseline.adoptions
          .filter((adoption) => adoption.legacyBound)
          .map((adoption) => [
            adoption.binding.notionId,
            adoption.binding.brainPageId,
          ]),
      ),
    );
  }
  const runContext =
    options.mode === "apply" ? await ensureRunStarted(options) : undefined;
  let reconciledAborts = 0;
  let preflightComplete = genericBaseline !== undefined;
  let mutationGateComplete = false;
  try {
    if (!genericBaseline) {
      await preflightDestination(options);
      preflightComplete = true;
    }
    if (options.mode === "apply") {
      await rolloverStoppedRunIfExhausted(options, runContext!);
      if (genericBaseline) {
        await applyGenericAdoptions(options, runContext!, genericBaseline);
        await preflightDestination(options);
      }
      mutationGateComplete = true;
      reconciledAborts = await reconcilePendingAborts(options, runContext!);
    }
    return await executeChannelPilotAfterPreflight(
      options,
      runContext,
      reconciledAborts,
    );
  } catch (error) {
    const code = safeErrorCode(error);
    let cleanup = { attempted: 0, aborted: 0, failed: 0 };
    if (
      options.mode === "apply" &&
      preflightComplete &&
      mutationGateComplete &&
      isTerminalImportError(error)
    ) {
      cleanup = await cleanupTerminalReservations(options, runContext!);
    }
    if (options.mode === "apply") {
      await appendOnce(options.journal, "run_stopped", undefined, {
        type: "run_stopped",
        runId: runContext?.runId ?? "unknown_run",
        fingerprint: plan.fingerprint,
        code,
        phase: preflightComplete ? "execution" : "preflight",
        cleanupAttempted: cleanup.attempted,
        cleanupAborted: cleanup.aborted,
        cleanupFailed: cleanup.failed,
      }).catch(() => undefined);
    }
    throw error;
  }
}

/** Validate the runtime-only v2 parameters before they can influence the
 * generic executor. Channel v1 has no marker and follows its original path. */
function genericExecutionPlan(
  plan: NotionExecutionPlan,
): GenericV2ExecutionPlan | undefined {
  const candidate = plan as Partial<GenericV2ExecutionPlan> & NotionExecutionPlan;
  if (candidate.version !== 2) return undefined;
  if (
    !(candidate.fixedPageIds instanceof Map) ||
    !Array.isArray(candidate.preservedBindings) ||
    !Array.isArray(candidate.adoptionBindings)
  ) {
    throw new Error("generic Notion v2 execution plan is missing fixed-id metadata");
  }
  const fixed = new Map(candidate.fixedPageIds);
  const expectedFixed = new Map<string, string>();
  const brainIds = new Set<string>();
  for (const binding of [
    ...candidate.preservedBindings,
    ...candidate.adoptionBindings,
  ]) {
    if (expectedFixed.has(binding.notionId) || brainIds.has(binding.brainPageId)) {
      throw new Error("generic Notion v2 fixed bindings are not unique");
    }
    expectedFixed.set(binding.notionId, binding.brainPageId);
    brainIds.add(binding.brainPageId);
  }
  if (
    fixed.size !== expectedFixed.size ||
    [...expectedFixed].some(
      ([notionId, pageId]) => fixed.get(notionId) !== pageId,
    )
  ) {
    throw new Error("generic Notion v2 fixed-id metadata does not match bindings");
  }
  for (const page of candidate.pages) {
    if (
      !("disposition" in page) ||
      (page.disposition !== "create" && page.disposition !== "adopt")
    ) {
      throw new Error("generic Notion v2 page disposition is invalid");
    }
    const fixedId = fixed.get(page.notionId);
    if (
      (page.disposition === "adopt" &&
        (!fixedId || page.brainPageId !== fixedId)) ||
      (page.disposition === "create" && fixedId !== undefined)
    ) {
      throw new Error("generic Notion v2 page does not match its fixed binding");
    }
  }
  for (const binding of candidate.adoptionBindings) {
    const page = candidate.pages.find(
      (current) => current.notionId === binding.notionId,
    );
    if (!page || page.disposition !== "adopt") {
      throw new Error("generic Notion v2 adoption has no active plan page");
    }
  }
  return candidate as GenericV2ExecutionPlan;
}

async function preflightGenericCandidates(
  options: NotionPreflightOptions,
  plan: GenericV2ExecutionPlan,
): Promise<GenericBaselinePreflight> {
  for (const pageId of plan.fixedPageIds.values()) assertBrainId(pageId);
  for (const binding of plan.preservedBindings) {
    const candidate = await requiredCandidate(options.client, binding.brainPageId);
    assertCandidateIdentity(candidate, binding.brainPageId);
    if (candidate.rev !== binding.expectedRev) {
      throw candidateBaselineError("preserved Brain page revision changed");
    }
    if (
      candidate.current.parentId !== binding.expectedParentId ||
      candidate.current.beforeId !== binding.expectedBeforeId
    ) {
      throw candidateBaselineError("preserved Brain page placement changed");
    }
    assertCandidateAvailable(candidate);
    if (candidate.bindingState === "tracked") {
      assertTrackedCandidate(candidate, binding.notionId);
    } else if (
      candidate.bindingState !== "unbound" &&
      !isUpgradeableLegacyCandidate(candidate, binding.notionId)
    ) {
      throw candidateBaselineError("preserved Brain page has unsupported binding state");
    }
  }

  const adoptions: GenericAdoptionBaseline[] = [];
  for (const page of plan.pages) {
    if (page.disposition !== "adopt") continue;
    const binding = plan.adoptionBindings.find(
      (current) => current.notionId === page.notionId,
    );
    if (!binding) throw new Error("generic Notion v2 adoption page is missing");
    const candidate = await requiredCandidate(options.client, binding.brainPageId);
    assertCandidateIdentity(candidate, binding.brainPageId);
    assertCandidateAvailable(candidate);
    let sourceHash: string;
    let alreadyTracked = false;
    const legacyBound = isUpgradeableLegacyCandidate(
      candidate,
      binding.notionId,
    );
    if (
      candidate.bindingState === "unbound" ||
      legacyBound
    ) {
      if (options.mode === "verify") {
        throw candidateBaselineError("Brain adoption has not been applied");
      }
      if (
        candidate.rev !== binding.expectedRev ||
        candidate.current.parentId !== binding.expectedParentId ||
        candidate.current.beforeId !== binding.expectedBeforeId
      ) {
        throw candidateBaselineError("Brain adoption baseline changed");
      }
      sourceHash = page.sourceHash;
    } else if (candidate.bindingState === "tracked") {
      assertTrackedCandidate(candidate, binding.notionId);
      if (!candidate.sourceHash || !candidate.conversionHash) {
        throw candidateBaselineError("tracked Brain candidate is incomplete");
      }
      sourceHash = candidate.sourceHash;
      alreadyTracked = true;
    } else {
      throw candidateBaselineError("Brain adoption candidate is already bound");
    }
    const read = await options.client.readPage(binding.brainPageId);
    const conversionHash = conversionHashForCandidate(
      candidate,
      read,
      sourceHash,
      alreadyTracked,
      legacyBound,
    );
    if (
      alreadyTracked &&
      conversionHash !== candidate.conversionHash
    ) {
      throw candidateBaselineError("tracked Brain candidate target changed");
    }
    adoptions.push({
      binding,
      page,
      candidate,
      sourceHash,
      conversionHash,
      alreadyTracked,
      legacyBound,
    });
  }
  return { plan, adoptions };
}

async function requiredCandidate(
  client: BrainImportClient,
  pageId: string,
): Promise<NotionCandidateBaseline> {
  const candidate = await client.inspectCandidate(pageId);
  if (!candidate) throw candidateBaselineError("Brain candidate is missing");
  return candidate;
}

function assertCandidateIdentity(
  candidate: NotionCandidateBaseline,
  expectedPageId: string,
): void {
  if (candidate.id !== expectedPageId) {
    throw candidateBaselineError("Brain candidate id changed");
  }
  assertBrainId(candidate.id);
  if (!candidate.rev || candidate.deleted) {
    throw candidateBaselineError("Brain candidate is deleted or has no revision");
  }
}

function assertCandidateAvailable(candidate: NotionCandidateBaseline): void {
  if (
    candidate.bindingState === "import_pending" ||
    candidate.bindingState === "abort_pending"
  ) {
    throw candidateBaselineError("Brain candidate has pending import state");
  }
}

function isUpgradeableLegacyCandidate(
  candidate: NotionCandidateBaseline,
  notionId: string,
): boolean {
  return (
    candidate.bindingState === "bound_untracked" &&
    candidate.legacyBindingUpgradeable === true &&
    candidate.notionId === notionId &&
    candidate.sourceHash === undefined &&
    candidate.conversionHash === undefined
  );
}

function assertTrackedCandidate(
  candidate: NotionCandidateBaseline,
  notionId: string,
): void {
  if (
    candidate.notionId !== notionId ||
    !candidate.sourceHash ||
    !candidate.conversionHash ||
    candidate.trackedTargetIntact !== true ||
    candidate.trackedAttachmentIntact !== true
  ) {
    throw candidateBaselineError("tracked Brain candidate binding is not intact");
  }
}

function conversionHashForCandidate(
  candidate: NotionCandidateBaseline,
  read: Awaited<ReturnType<BrainImportClient["readPage"]>>,
  sourceHash: string,
  alreadyTracked: boolean,
  legacyBound: boolean,
): string {
  if (read.meta.id !== candidate.id || read.rev !== candidate.rev) {
    throw candidateBaselineError("Brain candidate changed during preflight");
  }
  if (
    alreadyTracked
      ? read.meta.notionId !== candidate.notionId ||
        read.meta.notionSourceHash !== candidate.sourceHash ||
        read.meta.notionConversionHash !== candidate.conversionHash ||
        read.meta.notionTargetParentId !== candidate.current.parentId ||
        read.meta.notionTargetBeforeId !== candidate.current.beforeId ||
        typeof read.meta.notionTargetRev !== "string" ||
        typeof read.meta.notionTargetOrder !== "string"
      : legacyBound
        ? read.meta.notionId !== candidate.notionId ||
          read.meta.notionSourceHash !== undefined ||
          read.meta.notionConversionHash !== undefined ||
          read.meta.notionTargetRev !== undefined ||
          read.meta.notionTargetParentId !== undefined ||
          read.meta.notionTargetBeforeId !== undefined ||
          read.meta.notionTargetOrder !== undefined
        : read.meta.notionId !== undefined ||
          read.meta.notionSourceHash !== undefined ||
          read.meta.notionConversionHash !== undefined
  ) {
    throw candidateBaselineError("Brain candidate metadata changed during preflight");
  }
  return notionConversionHash(
    canonicalizeNotionImportTarget({
      sourceHash,
      parentId: candidate.current.parentId,
      beforeId: candidate.current.beforeId,
      title: read.meta.title,
      icon: read.meta.icon,
      cover: read.meta.cover,
      markdown: read.markdown,
      collection: read.meta.collection,
      collectionRow: read.meta.collectionRow,
    }),
  );
}

async function applyGenericAdoptions(
  options: ExecuteNotionExecutionOptions,
  runContext: RemoteRunContext,
  baseline: GenericBaselinePreflight,
): Promise<void> {
  for (const adoption of baseline.adoptions) {
    if (adoption.alreadyTracked) {
      const previous = options.journal.latest(
        "page_adopted",
        adoption.binding.notionId,
      );
      if (
        previous?.pageId !== adoption.binding.brainPageId ||
        previous.sourceHash !== adoption.sourceHash ||
        previous.conversionHash !== adoption.conversionHash
      ) {
        await appendPageEventOnce(options.journal, {
          type: "page_adopted",
          notionId: adoption.binding.notionId,
          sourceHash: adoption.sourceHash,
          conversionHash: adoption.conversionHash,
          pageId: adoption.binding.brainPageId,
          rev: adoption.candidate.rev,
          recoveredAcknowledgement: true,
        });
      }
      continue;
    }
    await ensureRemoteMutationCapacity(options, runContext, "normal");
    const result = await options.client.adoptPage({
      pageId: adoption.binding.brainPageId,
      notionId: adoption.binding.notionId,
      sourceHash: adoption.sourceHash,
      conversionHash: adoption.conversionHash,
      expectedRev: adoption.binding.expectedRev,
      expectedParentId: adoption.binding.expectedParentId,
      expectedBeforeId: adoption.binding.expectedBeforeId,
    });
    if (
      result.page.id !== adoption.binding.brainPageId ||
      result.page.notionId !== adoption.binding.notionId ||
      result.page.sourceHash !== adoption.sourceHash ||
      result.page.conversionHash !== adoption.conversionHash ||
      result.page.deleted ||
      result.page.current.parentId !== adoption.binding.expectedParentId ||
      result.page.current.beforeId !== adoption.binding.expectedBeforeId ||
      !result.rev
    ) {
      throw candidateBaselineError("Brain adoption acknowledgement changed");
    }
    await appendPageEventOnce(options.journal, {
      type: "page_adopted",
      notionId: adoption.binding.notionId,
      sourceHash: adoption.sourceHash,
      conversionHash: adoption.conversionHash,
      pageId: adoption.binding.brainPageId,
      rev: result.rev,
      recoveredAcknowledgement: false,
    });
  }
}

function candidateBaselineError(message: string): ChannelPilotError {
  return new ChannelPilotError("candidate_baseline_drift", message);
}

async function executeChannelPilotAfterPreflight(
  options: ExecuteNotionExecutionOptions,
  runContext?: RemoteRunContext,
  reconciledAborts = 0,
): Promise<ExecuteNotionExecutionResult> {
  const { prepared, client, journal, mode } = options;
  const plan = prepared.plan;
  const counts = {
    reserves: 0,
    uploads: 0,
    finalizes: 0,
    aborts: reconciledAborts,
  };
  const initial = new Map<string, NotionImportStatus | null>();
  const pageIds = fixedPageIds(plan);

  for (const page of plan.pages) {
    const found = await client.findPage(page.notionId);
    initial.set(page.notionId, found);
    if (found) {
      assertBrainId(found.id);
      const mapped = pageIds.get(page.notionId);
      if (mapped && mapped !== found.id) {
        throw new Error("Channel pilot Notion id mapped to a different Brain page");
      }
      assertUniqueMappedPageId(pageIds, page.notionId, found.id);
      pageIds.set(page.notionId, found.id);
    }
  }
  if (mode === "apply" && allPlanPagesMapped(plan, pageIds)) {
    await reconcileCompletedFinalizes(
      plan,
      buildDesiredPages(plan, pageIds, prepared.assets),
      initial,
      client,
      journal,
    );
  }
  if (mode === "verify") {
    if (!allPlanPagesMapped(plan, pageIds)) {
      throw new Error("Channel pilot verification found missing Brain pages");
    }
    const desired = buildDesiredPages(plan, pageIds, prepared.assets);
    const verified = await verifyPages(
      plan,
      desired,
      pageIds,
      client,
      journal,
    );
    return {
      mode,
      pages: plan.pages.length,
      attachments: plan.counts.assets,
      remoteMutations: counts,
      verified,
    };
  }

  const completedRun = runContext?.completed === true;
  if (!completedRun) {
    for (const page of plan.pages) {
      const found = initial.get(page.notionId) ?? null;
      await appendPageEventOnce(journal, {
        type: "page_planned",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        parentNotionId: page.parentNotionId,
        beforeNotionId: page.beforeNotionId,
        action: found ? "update" : "create",
      });
    }
  }
  const reservations = new Map<string, string>();
  const deferred = new Set<string>();
  for (const page of plan.pages) {
    const found = initial.get(page.notionId) ?? null;
    if (
      found &&
      !found.deleted &&
      !found.importing &&
      found.sourceHash === page.sourceHash &&
      typeof found.conversionHash === "string"
    ) {
      deferred.add(page.notionId);
      continue;
    }
    const token = await reservationToken(page, journal, options.tokenFactory);
    reservations.set(page.notionId, token);
    const result = await reserveWithRetry(
      () => client.reservePage(reserveInput(page, pageIds, token, null, journal)),
      options,
      async () => {
        await ensureRemoteMutationCapacity(options, runContext!, "normal");
        counts.reserves += 1;
      },
    );
    acceptReservation(page, result, token, pageIds);
    await appendPageEventOnce(journal, {
      type: "page_reserved",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      pageId: result.page.id,
      reservationToken: token,
      status: result.status,
      pass: 1,
      ...reservationHierarchy(result.page),
    });
  }
  if (!allPlanPagesMapped(plan, pageIds)) {
    throw new Error("Channel pilot pass one did not map every page id");
  }

  let desired = buildDesiredPages(plan, pageIds, prepared.assets);
  if (genericExecutionPlan(plan)) {
    await reconcileCompletedFinalizes(
      plan,
      desired,
      initial,
      client,
      journal,
    );
  }
  const needsWork = new Set<string>();
  for (const page of plan.pages) {
    const found = initial.get(page.notionId) ?? null;
    const target = desired.get(page.notionId);
    if (!target) throw new Error("Channel pilot desired page is missing");
    if (isComplete(found, page, target)) continue;
    needsWork.add(page.notionId);
    await appendPageEventOnce(journal, {
      type: "page_target_planned",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      parentId: target.parentId,
      beforeId: target.beforeId,
      action: found ? "update" : "create",
    });
    if (!reservations.has(page.notionId)) {
      if (!deferred.has(page.notionId)) {
        throw new Error("Channel pilot page has no pass-one reservation state");
      }
      const token = await reservationToken(page, journal, options.tokenFactory);
      reservations.set(page.notionId, token);
      const passOne = await reserveWithRetry(
        () => client.reservePage(reserveInput(page, pageIds, token, null, journal)),
        options,
        async () => {
          await ensureRemoteMutationCapacity(options, runContext!, "normal");
          counts.reserves += 1;
        },
      );
      acceptReservation(page, passOne, token, pageIds);
      await appendPageEventOnce(journal, {
        type: "page_reserved",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        pageId: passOne.page.id,
        reservationToken: token,
        status: passOne.status,
        pass: 1,
        ...reservationHierarchy(passOne.page),
      });
    }
  }
  desired = buildDesiredPages(plan, pageIds, prepared.assets);

  const reservedForFinalize = new Set<string>();
  for (const page of plan.pages) {
    if (!needsWork.has(page.notionId)) continue;
    const target = desired.get(page.notionId);
    const token = reservations.get(page.notionId);
    if (!target || !token) throw new Error("Channel pilot pass two is incomplete");
    const result = await reserveWithRetry(
      () => client.reservePage(reserveInput(page, pageIds, token, target, journal)),
      options,
      async () => {
        await ensureRemoteMutationCapacity(options, runContext!, "normal");
        counts.reserves += 1;
      },
    );
    acceptReservation(page, result, token, pageIds);
    await appendPageEventOnce(journal, {
      type: "page_reserved",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      pageId: result.page.id,
      reservationToken: token,
      status: result.status,
      pass: 2,
      ...reservationHierarchy(result.page),
    });
    if (result.status === "reserved") {
      reservedForFinalize.add(page.notionId);
    } else if (result.status !== "unchanged") {
      throw new Error("Channel pilot pass two did not reserve or match a page");
    }
  }

  for (const page of plan.pages) {
    if (!reservedForFinalize.has(page.notionId)) continue;
    const token = reservations.get(page.notionId);
    if (!token) throw new Error("Channel pilot upload has no reservation token");
    for (const sourceId of page.assetSourceIds) {
      const asset = prepared.assets.get(sourceId);
      if (!asset) throw new Error("Channel pilot upload asset is missing");
      const saved = await retryBusy(
        () => client.uploadAttachment({
          notionId: page.notionId,
          sourceHash: page.sourceHash,
          reservationToken: token,
          asset,
        }),
        options,
        async () => {
          await ensureRemoteMutationCapacity(options, runContext!, "normal");
          counts.uploads += 1;
        },
      );
      const expectedUrl = notionAttachmentUrl(
        asset.sha256,
        asset.name,
        asset.mimeType,
      );
      if (
        saved.url !== expectedUrl ||
        saved.size !== asset.bytes.byteLength ||
        saved.type !== asset.mimeType
      ) {
        throw new ChannelPilotError(
          "attachment_ack_mismatch",
          "Channel pilot attachment acknowledgement does not match bytes",
        );
      }
      const verifiedAttachment = await client.verifyAttachment({
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        reservationToken: token,
        url: saved.url,
      });
      if (
        verifiedAttachment.url !== expectedUrl ||
        verifiedAttachment.size !== asset.bytes.byteLength ||
        verifiedAttachment.sha256 !== asset.sha256
      ) {
        throw new ChannelPilotError(
          "attachment_readback_mismatch",
          "Channel pilot remote attachment bytes failed read-back verification",
        );
      }
      await appendPageEventOnce(journal, {
        type: "attachment_saved",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        reservationToken: token,
        sourceId,
        sha256: asset.sha256,
        size: asset.bytes.byteLength,
        mimeType: asset.mimeType,
        url: expectedUrl,
      });
    }
  }

  for (const page of plan.pages) {
    if (!reservedForFinalize.has(page.notionId)) continue;
    const target = desired.get(page.notionId);
    const token = reservations.get(page.notionId);
    if (!target || !token) throw new Error("Channel pilot finalize state is incomplete");
    await ensureRemoteMutationCapacity(options, runContext!, "normal");
    const result = await client.finalizePage({
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      reservationToken: token,
      markdown: target.markdown,
      title: page.document.title,
      icon: page.document.icon ?? "",
      cover: target.cover ?? "",
      ...(target.collection !== undefined
        ? { collection: target.collection }
        : {}),
      ...(target.collectionRow !== undefined
        ? { collectionRow: target.collectionRow }
        : {}),
    });
    counts.finalizes += 1;
    if (result.page.id !== pageIds.get(page.notionId)) {
      throw new Error("Channel pilot finalize returned a different page id");
    }
    await verifyFinalizedAttachments(page, target, client);
    await appendPageEventOnce(journal, {
      type: "page_finalized",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      pageId: result.page.id,
      rev: result.rev,
      status: result.status,
      stagingRemoved: result.cleanup.stagingRemoved,
    });
  }

  const verified = await verifyPages(
    plan,
    desired,
    pageIds,
    client,
    journal,
  );
  await appendOnce(journal, "run_completed", undefined, {
    type: "run_completed",
    runId: runContext?.runId ?? "unknown_run",
    fingerprint: plan.fingerprint,
    pages: plan.pages.length,
    assets: plan.counts.assets,
    verified,
  });
  if (runContext) runContext.completed = true;
  return {
    mode,
    pages: plan.pages.length,
    attachments: plan.counts.assets,
    remoteMutations: counts,
    verified,
  };
}

function reservationHierarchy(status: NotionImportStatus): {
  currentParentId: string | null;
  currentBeforeId: string | null;
  trackedParentId: string | null;
  trackedBeforeId: string | null;
  trackedOrder: string | null;
} {
  return {
    currentParentId: status.current.parentId,
    currentBeforeId: status.current.beforeId,
    trackedParentId: status.trackedBaseline?.parentId ?? null,
    trackedBeforeId: status.trackedBaseline?.beforeId ?? null,
    trackedOrder: status.trackedBaseline?.order ?? null,
  };
}

async function ensureRunStarted(
  options: ExecuteNotionExecutionOptions,
): Promise<RemoteRunContext> {
  const { plan } = options.prepared;
  const previousRecord = latestRecord(options.journal, "run_started");
  if (
    previousRecord?.event.fingerprint === plan.fingerprint &&
    typeof previousRecord.event.runId === "string"
  ) {
    const runId = previousRecord.event.runId;
    const terminal = [...options.journal.records].reverse().find(
      (record) =>
        record.seq > previousRecord.seq &&
        (record.event.type === "run_completed" ||
          record.event.type === "run_stopped") &&
        record.event.runId === runId &&
        record.event.fingerprint === plan.fingerprint,
    );
    return {
      runId,
      completed: terminal?.event.type === "run_completed",
      stopped: terminal?.event.type === "run_stopped",
      capacityReady: false,
    };
  }
  const runId = randomBytes(16).toString("hex");
  await options.journal.append(runStartedEvent(options, runId));
  return { runId, completed: false, stopped: false, capacityReady: false };
}

function runStartedEvent(
  options: ExecuteNotionExecutionOptions,
  runId: string,
): PilotJournalEvent {
  const { plan } = options.prepared;
  return {
    type: "run_started",
    runId,
    fingerprint: plan.fingerprint,
    rootNotionId: plan.rootNotionId,
    converterVersion: NOTION_CONVERTER_VERSION,
    pages: plan.counts.pages,
    assets: plan.counts.assets,
    emptyBlocks: plan.counts.emptyBlocks,
    hardBreaks: plan.counts.hardBreaks,
    externalLinks: plan.counts.externalLinks,
  };
}

async function ensureRemoteMutationCapacity(
  options: ExecuteNotionExecutionOptions,
  context: RemoteRunContext,
  kind: "normal" | "cleanup",
): Promise<void> {
  if (context.completed) {
    await rotateRemoteRun(options, context);
  }
  if (!context.capacityReady) {
    await options.journal.activateRemoteRunCapacity(
      context.runId,
      options.prepared.plan.fingerprint,
    );
    context.capacityReady = true;
  }
  options.journal.assertRemoteMutationCapacity(kind);
}

async function rolloverStoppedRunIfExhausted(
  options: ExecuteNotionExecutionOptions,
  context: RemoteRunContext,
): Promise<void> {
  if (!context.stopped || !hasRunCapacity(options, context.runId)) return;
  try {
    await options.journal.activateRemoteRunCapacity(
      context.runId,
      options.prepared.plan.fingerprint,
    );
    context.capacityReady = true;
    options.journal.assertRemoteMutationCapacity("normal");
  } catch (error) {
    context.capacityReady = false;
    if (notionPilotErrorCode(error) !== "journal_capacity") throw error;
    await rotateRemoteRun(options, context);
  }
}

function hasRunCapacity(
  options: ExecuteNotionExecutionOptions,
  runId: string,
): boolean {
  return options.journal.records.some(
    (record) =>
      record.event.type === "capacity_reserved" &&
      record.event.runId === runId &&
      record.event.fingerprint === options.prepared.plan.fingerprint,
  );
}

async function rotateRemoteRun(
  options: ExecuteNotionExecutionOptions,
  context: RemoteRunContext,
): Promise<void> {
  const runId = randomBytes(16).toString("hex");
  const event = runStartedEvent(options, runId);
  options.journal.assertNewRemoteRunCapacity(event);
  await options.journal.append(event);
  context.runId = runId;
  context.completed = false;
  context.stopped = false;
  context.capacityReady = false;
  await options.journal.activateRemoteRunCapacity(
    runId,
    options.prepared.plan.fingerprint,
  );
  context.capacityReady = true;
  options.journal.assertRemoteMutationCapacity("normal");
}

/** Complete every destination read before the first reserve call. A later
 * reserve still revalidates the same baselines under Store's mutation lock,
 * but no page can be created before drift on another page is discovered. */
async function preflightDestination(
  options: NotionPreflightOptions,
  acceptedLegacyAdoptions: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const brainIdOwners = new Map<string, string>();
  for (const [notionId, pageId] of fixedPageIds(options.prepared.plan)) {
    const owner = brainIdOwners.get(pageId);
    if (owner && owner !== notionId) {
      throw new ChannelPilotError(
        "destination_mapping_conflict",
        "Notion ids map to the same Brain page",
      );
    }
    brainIdOwners.set(pageId, notionId);
  }
  let foundPages = 0;
  for (const page of options.prepared.plan.pages) {
    const preparedToken = options.journal.latest(
      "token_prepared",
      page.notionId,
    );
    const candidateToken =
      typeof preparedToken?.reservationToken === "string" &&
      validReservationToken(preparedToken.reservationToken)
        ? preparedToken.reservationToken
        : undefined;
    const status = await options.client.findPage(
      page.notionId,
      candidateToken,
    );
    if (!status) continue;
    foundPages += 1;
    assertBrainId(status.id);
    const owner = brainIdOwners.get(status.id);
    if (owner && owner !== page.notionId) {
      throw new ChannelPilotError(
        "destination_mapping_conflict",
        "Channel pilot Notion ids map to the same Brain page",
      );
    }
    brainIdOwners.set(status.id, page.notionId);
    if (normalizeNotionId(status.notionId) !== page.notionId) {
      throw new ChannelPilotError(
        "destination_mapping_conflict",
        "Channel pilot destination returned a different Notion id",
      );
    }
    if (status.deleted) {
      throw new ChannelPilotError(
        "destination_deleted",
        "Channel pilot destination contains a deleted page",
      );
    }
    if (status.pendingAbort) {
      if (options.mode === "verify") {
        throw new ChannelPilotError(
          "abort_ack_required",
          "Channel pilot verification found an unacknowledged abort",
        );
      }
      if (
        preparedToken?.sourceHash !== status.pendingAbort.sourceHash ||
        !candidateToken ||
        status.integrity?.reservationOwned !== true ||
        status.integrity.abortBaselineIntact !== true
      ) {
        throw new ChannelPilotError(
          "destination_busy",
          "Channel pilot found an abort receipt owned by another or changed run",
        );
      }
      const read = await options.client.readPage(status.id);
      if (
        read.meta.id !== status.id ||
        (status.pendingAbort.status === "detached"
          ? read.meta.notionId !== undefined
          : normalizeOptionalNotionId(read.meta.notionId) !== page.notionId)
      ) {
        throw new ChannelPilotError(
          "destination_mapping_conflict",
          "Channel pilot abort receipt page metadata does not match its status",
        );
      }
      continue;
    }
    const read = await options.client.readPage(status.id);
    if (
      read.meta.id !== status.id ||
      normalizeOptionalNotionId(read.meta.notionId) !== page.notionId ||
      read.meta.title !== status.title ||
      (read.meta.icon ?? undefined) !== (status.icon ?? undefined) ||
      !read.rev
    ) {
      throw new ChannelPilotError(
        "destination_mapping_conflict",
        "Channel pilot destination page metadata does not match its mapping",
      );
    }
    const acceptedLegacyPageId = acceptedLegacyAdoptions.get(page.notionId);
    if (acceptedLegacyPageId !== undefined) {
      if (
        status.id !== acceptedLegacyPageId ||
        status.sourceHash !== undefined ||
        status.conversionHash !== undefined ||
        status.trackedBaseline !== undefined ||
        status.importing !== undefined ||
        normalizeOptionalNotionId(read.meta.notionId) !== page.notionId ||
        read.meta.notionSourceHash !== undefined ||
        read.meta.notionConversionHash !== undefined ||
        read.meta.notionTargetRev !== undefined ||
        read.meta.notionTargetParentId !== undefined ||
        read.meta.notionTargetBeforeId !== undefined ||
        read.meta.notionTargetOrder !== undefined
      ) {
        throw new ChannelPilotError(
          "destination_drift",
          "generic Notion legacy adoption baseline is not exact",
        );
      }
      continue;
    }
    if (status.importing) {
      if (options.mode === "verify") {
        throw new ChannelPilotError(
          "destination_busy",
          "Channel pilot verification found an active reservation",
        );
      }
      if (status.integrity?.importBaselineIntact !== true) {
        throw new ChannelPilotError(
          "destination_drift",
          "Channel pilot active reservation baseline has drifted",
        );
      }
      if (
        status.importing.leaseFresh &&
        (status.importing.sourceHash !== page.sourceHash ||
          !candidateToken ||
          status.integrity.reservationOwned !== true)
      ) {
        throw new ChannelPilotError(
          "destination_busy",
          "Channel pilot destination is reserved by an unowned run",
        );
      }
      continue;
    }
    if (
      !status.sourceHash ||
      !status.conversionHash ||
      !status.trackedBaseline ||
      status.integrity?.trackedTargetIntact !== true ||
      typeof status.integrity?.trackedAttachmentIntact !== "boolean" ||
      status.current.parentId !== status.trackedBaseline.parentId ||
      status.current.beforeId !== status.trackedBaseline.beforeId ||
      read.meta.notionSourceHash !== status.sourceHash ||
      read.meta.notionConversionHash !== status.conversionHash ||
      read.meta.notionTargetParentId !== status.trackedBaseline.parentId ||
      read.meta.notionTargetBeforeId !== status.trackedBaseline.beforeId ||
      read.meta.notionTargetOrder !== status.trackedBaseline.order ||
      typeof read.meta.notionTargetRev !== "string"
    ) {
      throw new ChannelPilotError(
        "destination_drift",
        "Channel pilot destination body, metadata, or hierarchy has drifted",
      );
    }
  }
  if (
    options.mode === "verify" &&
    foundPages !== options.prepared.plan.pages.length
  ) {
    throw new ChannelPilotError(
      "destination_missing",
      "Channel pilot verification found missing Brain pages",
    );
  }
}

async function reconcilePendingAborts(
  options: ExecuteNotionExecutionOptions,
  runContext: RemoteRunContext,
): Promise<number> {
  let reconciled = 0;
  for (const page of options.prepared.plan.pages) {
    const preparedToken = options.journal.latest(
      "token_prepared",
      page.notionId,
    );
    if (
      typeof preparedToken?.reservationToken !== "string" ||
      !validReservationToken(preparedToken.reservationToken)
    ) {
      continue;
    }
    const status = await options.client.findPage(
      page.notionId,
      preparedToken.reservationToken,
    );
    if (!status?.pendingAbort) continue;
    if (
      preparedToken.sourceHash !== status.pendingAbort.sourceHash ||
      status.integrity?.reservationOwned !== true ||
      status.integrity.abortBaselineIntact !== true
    ) {
      throw new ChannelPilotError(
        "destination_busy",
        "Channel pilot cannot reconcile an unowned or changed abort receipt",
      );
    }
    await ensureRemoteMutationCapacity(options, runContext, "cleanup");
    const result = await options.client.abortPage({
      notionId: page.notionId,
      sourceHash: status.pendingAbort.sourceHash,
      reservationToken: preparedToken.reservationToken,
    });
    await appendPageEventOnce(options.journal, {
      type: "page_aborted",
      notionId: page.notionId,
      sourceHash: status.pendingAbort.sourceHash,
      reservationToken: preparedToken.reservationToken,
      pageId: result.pageId,
      status: result.status,
      stagingRemoved: result.cleanup.stagingRemoved,
      notionBindingRemoved: result.cleanup.notionBindingRemoved,
      placeholderPreserved: result.cleanup.placeholderPreserved,
    });
    reconciled += 1;
  }
  return reconciled;
}

function buildDesiredPages(
  plan: NotionExecutionPlan,
  pageIds: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, ResolvedNotionAsset>,
): Map<string, DesiredPage> {
  if (!allPlanPagesMapped(plan, pageIds)) {
    throw new Error("Channel pilot cannot convert before every page id is mapped");
  }
  const desired = new Map<string, DesiredPage>();
  for (const page of plan.pages) {
    const parentId = page.parentNotionId
      ? requiredPageId(pageIds, page.parentNotionId)
      : null;
    const beforeId = page.beforeNotionId
      ? requiredPageId(pageIds, page.beforeNotionId)
      : null;
    const attachments = new Map<
      string,
      { url: string; sha256: string; size: number }
    >();
    const addAttachment = (
      sourceId: string,
      sha256: string,
      name: string,
      mimeType: string,
    ) => {
      const asset = assets.get(sourceId);
      if (!asset || asset.sha256 !== sha256) {
        throw new Error("Channel pilot desired attachment descriptor drifted");
      }
      attachments.set(sourceId, {
        url: notionAttachmentUrl(sha256, name, mimeType),
        sha256,
        size: asset.bytes.byteLength,
      });
    };
    for (const block of page.document.blocks) {
      if (block.type !== "attachment") continue;
      addAttachment(
        block.sourceId,
        block.sha256,
        block.name,
        block.mimeType,
      );
    }
    if (page.document.cover) {
      addAttachment(
        page.document.cover.sourceId,
        page.document.cover.sha256,
        page.document.cover.name,
        page.document.cover.mimeType,
      );
    }
    if (attachments.size !== page.assetSourceIds.length) {
      throw new Error("Channel pilot desired attachment inventory is incomplete");
    }
    const attachmentUrls = new Map(
      [...attachments].map(([sourceId, attachment]) => [
        sourceId,
        attachment.url,
      ]),
    );
    const options = {
      parentId,
      beforeId,
      pageIdByNotionId: pageIds,
      attachmentUrlBySourceId: attachmentUrls,
    };
    const conversion = convertNotionDocumentWithIssues(page.document, options);
    assertNotionConversionReady(conversion);
    const cover = page.document.cover
      ? notionAttachmentUrl(
          page.document.cover.sha256,
          page.document.cover.name,
          page.document.cover.mimeType,
        )
      : undefined;
    desired.set(page.notionId, {
      parentId,
      beforeId,
      conversionHash: conversionHashForNotionDocument(page.document, options, {
        collection: page.collection,
        collectionRow: page.collectionRow,
      }),
      markdown: conversion.markdown,
      cover,
      collection: page.collection,
      collectionRow: page.collectionRow,
      attachments,
    });
  }
  return desired;
}

function reserveInput(
  page: NotionExecutionPage,
  pageIds: ReadonlyMap<string, string>,
  reservationTokenValue: string,
  desired: DesiredPage | null,
  journal: PilotJournal,
): ReserveNotionImportInput {
  const parentId = page.parentNotionId
    ? requiredPageId(pageIds, page.parentNotionId)
    : null;
  const abortedRecord = latestRecord(journal, "page_aborted", page.notionId);
  const reservedRecord = latestRecord(journal, "page_reserved", page.notionId);
  const aborted =
    abortedRecord && (!reservedRecord || abortedRecord.seq > reservedRecord.seq)
      ? abortedRecord.event
      : undefined;
  const acknowledgedAbort =
    typeof aborted?.sourceHash === "string" &&
    /^[a-f0-9]{64}$/.test(aborted.sourceHash) &&
    typeof aborted.reservationToken === "string" &&
    validReservationToken(aborted.reservationToken)
      ? {
          sourceHash: aborted.sourceHash,
          reservationToken: aborted.reservationToken,
        }
      : undefined;
  return {
    notionId: page.notionId,
    sourceHash: page.sourceHash,
    conversionHash: desired?.conversionHash,
    parentId,
    beforeId: desired?.beforeId ?? null,
    title: page.document.title,
    icon: page.document.icon ?? "",
    cover: desired?.cover ?? "",
    reservationToken: reservationTokenValue,
    acknowledgedAbort,
  };
}

function acceptReservation(
  page: NotionExecutionPage,
  result: Awaited<ReturnType<BrainImportClient["reservePage"]>>,
  token: string,
  pageIds: Map<string, string>,
): void {
  if (result.status === "busy") {
    throw new ChannelPilotError(
      "busy",
      "Channel pilot page is reserved by another importer",
      result.retryAfterMs,
    );
  }
  assertBrainId(result.page.id);
  const mapped = pageIds.get(page.notionId);
  if (mapped && mapped !== result.page.id) {
    throw new Error("Channel pilot Notion id mapped to a different Brain page");
  }
  if (result.status === "reserved" && result.reservationToken !== token) {
    throw new Error("Channel pilot reservation token acknowledgement changed");
  }
  assertUniqueMappedPageId(pageIds, page.notionId, result.page.id);
  pageIds.set(page.notionId, result.page.id);
}

function isComplete(
  status: NotionImportStatus | null,
  page: NotionExecutionPage,
  target: DesiredPage,
): boolean {
  return (
    !!status &&
    !status.deleted &&
    !status.importing &&
    !status.pendingAbort &&
    status.sourceHash === page.sourceHash &&
    status.conversionHash === target.conversionHash &&
    status.integrity?.trackedTargetIntact === true &&
    status.integrity.trackedAttachmentIntact === true &&
    status.current.parentId === target.parentId &&
    status.current.beforeId === target.beforeId &&
    status.trackedBaseline?.parentId === target.parentId &&
    status.trackedBaseline.beforeId === target.beforeId &&
    typeof status.trackedBaseline.order === "string" &&
    status.trackedBaseline.order.length > 0
  );
}

async function reconcileCompletedFinalizes(
  plan: NotionExecutionPlan,
  desired: ReadonlyMap<string, DesiredPage>,
  initial: ReadonlyMap<string, NotionImportStatus | null>,
  client: BrainImportClient,
  journal: PilotJournal,
): Promise<void> {
  for (const page of plan.pages) {
    const target = desired.get(page.notionId);
    const status = initial.get(page.notionId) ?? null;
    if (!target || !isComplete(status, page, target) || !status) continue;
    const previous = journal.latest("page_finalized", page.notionId);
    if (
      previous?.sourceHash === page.sourceHash &&
      previous.conversionHash === target.conversionHash &&
      previous.pageId === status.id &&
      typeof previous.rev === "string" &&
      previous.rev.length > 0
    ) {
      continue;
    }
    const read = await client.readPage(status.id);
    assertCanonicalRemotePage(page, target, status, read);
    await verifyFinalizedAttachments(page, target, client);
    await journal.append({
      type: "page_finalized",
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      pageId: status.id,
      rev: read.rev,
      status: "unchanged",
      stagingRemoved: false,
      recoveredAcknowledgement: true,
    });
  }
}

async function verifyPages(
  plan: NotionExecutionPlan,
  desired: ReadonlyMap<string, DesiredPage>,
  pageIds: ReadonlyMap<string, string>,
  client: BrainImportClient,
  journal: PilotJournal,
): Promise<number> {
  let verified = 0;
  for (const page of plan.pages) {
    const target = desired.get(page.notionId);
    if (!target) throw new Error("Channel pilot verify target is missing");
    const status = await client.findPage(page.notionId);
    if (!isComplete(status, page, target)) {
      throw new Error("Channel pilot verification found target drift");
    }
    if (status?.id !== requiredPageId(pageIds, page.notionId)) {
      throw new Error("Channel pilot verification found id drift");
    }
    const read = await client.readPage(status.id);
    assertCanonicalRemotePage(page, target, status, read);
    for (const attachment of target.attachments.values()) {
      if (
        attachment.url !== target.cover &&
        !read.markdown.includes(attachment.url)
      ) {
        throw new Error("Channel pilot read-back is missing an attachment");
      }
    }
    await verifyFinalizedAttachments(page, target, client);
    const readHash = createHash("sha256").update(read.markdown).digest("hex");
    const previous = journal.latest("page_verified", page.notionId);
    if (
      previous?.sourceHash !== page.sourceHash ||
      previous.conversionHash !== target.conversionHash ||
      previous.readHash !== readHash
    ) {
      await journal.append({
        type: "page_verified",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        conversionHash: target.conversionHash,
        pageId: status.id,
        readHash,
        hierarchy: true,
        attachments: target.attachments.size,
      });
    }
    verified += 1;
  }
  return verified;
}

function assertCanonicalRemotePage(
  page: NotionExecutionPage,
  target: DesiredPage,
  status: NotionImportStatus,
  read: Awaited<ReturnType<BrainImportClient["readPage"]>>,
): void {
  if (
    !isComplete(status, page, target) ||
    read.meta.id !== status.id ||
    read.meta.title !== page.document.title ||
    (read.meta.icon ?? undefined) !== (page.document.icon ?? undefined) ||
    (read.meta.cover ?? undefined) !== target.cover ||
    !isDeepStrictEqual(read.meta.collection, target.collection ?? undefined) ||
    !isDeepStrictEqual(read.meta.collectionRow, target.collectionRow ?? undefined) ||
    read.meta.order !== status.trackedBaseline?.order ||
    read.meta.notionId !== page.notionId ||
    read.meta.notionSourceHash !== page.sourceHash ||
    read.meta.notionConversionHash !== target.conversionHash ||
    read.meta.notionTargetParentId !== target.parentId ||
    read.meta.notionTargetBeforeId !== target.beforeId ||
    read.meta.notionTargetOrder !== status.trackedBaseline?.order ||
    typeof read.meta.notionTargetRev !== "string" ||
    read.meta.notionTargetRev.length === 0 ||
    read.markdown !== target.markdown ||
    !read.rev
  ) {
    throw new Error("Channel pilot read-back does not match the canonical target");
  }
}

async function verifyFinalizedAttachments(
  page: NotionExecutionPage,
  target: DesiredPage,
  client: BrainImportClient,
): Promise<void> {
  for (const attachment of target.attachments.values()) {
    const verified = await client.verifyFinalizedAttachment({
      notionId: page.notionId,
      sourceHash: page.sourceHash,
      conversionHash: target.conversionHash,
      url: attachment.url,
    });
    if (
      verified.url !== attachment.url ||
      verified.sha256 !== attachment.sha256 ||
      verified.size !== attachment.size
    ) {
      throw new ChannelPilotError(
        "finalized_attachment_readback_mismatch",
        "Channel pilot permanent attachment bytes failed read-back verification",
      );
    }
  }
}

async function reservationToken(
  page: NotionExecutionPage,
  journal: PilotJournal,
  factory: (() => string) | undefined,
): Promise<string> {
  const previous = journal.latest("token_prepared", page.notionId);
  if (
    previous?.sourceHash === page.sourceHash &&
    typeof previous.reservationToken === "string" &&
    validReservationToken(previous.reservationToken)
  ) {
    return previous.reservationToken;
  }
  const token = factory?.() ?? randomBytes(24).toString("base64url");
  if (!validReservationToken(token)) {
    throw new Error("Channel pilot token factory returned an invalid token");
  }
  await journal.append({
    type: "token_prepared",
    notionId: page.notionId,
    sourceHash: page.sourceHash,
    reservationToken: token,
  });
  return token;
}

async function appendPageEventOnce(
  journal: PilotJournal,
  event: PilotJournalEvent & {
    notionId: string;
    sourceHash: string;
  },
): Promise<void> {
  const barrierTypes = eventBarriers(event.type);
  const barrierSeq = barrierTypes.reduce(
    (latest, type) =>
      Math.max(latest, latestRecord(journal, type, event.notionId)?.seq ?? 0),
    0,
  );
  const equivalent = [...journal.records].reverse().find(
    (record) =>
      record.seq > barrierSeq &&
      record.event.type === event.type &&
      record.event.notionId === event.notionId &&
      shallowEventEqual(record.event, event),
  );
  if (equivalent) {
    return;
  }
  await journal.append(event);
}

function shallowEventEqual(
  left: PilotJournalEvent,
  right: PilotJournalEvent,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(([key, value]) => left[key] === value)
  );
}

function eventBarriers(type: string): readonly string[] {
  switch (type) {
    case "page_reserved":
      return ["page_aborted", "page_finalized"];
    case "page_finalized":
      return ["page_reserved", "page_aborted"];
    case "page_aborted":
      return ["page_reserved"];
    case "attachment_saved":
      return ["page_reserved", "page_aborted", "page_finalized"];
    case "page_abort_failed":
      return ["page_reserved", "page_aborted"];
    default:
      return [];
  }
}

function latestRecord(
  journal: PilotJournal,
  type: string,
  notionId?: string,
): PilotJournal["records"][number] | undefined {
  for (let index = journal.records.length - 1; index >= 0; index -= 1) {
    const record = journal.records[index];
    if (
      record.event.type === type &&
      (notionId === undefined || record.event.notionId === notionId)
    ) {
      return record;
    }
  }
  return undefined;
}

async function appendOnce(
  journal: PilotJournal,
  type: string,
  notionId: string | undefined,
  event: PilotJournalEvent,
): Promise<void> {
  const previous = journal.latest(type, notionId);
  if (
    previous &&
    Object.entries(event).every(([key, value]) => previous[key] === value)
  ) {
    return;
  }
  await journal.append(event);
}

function requiredPageId(
  pageIds: ReadonlyMap<string, string>,
  notionId: string,
): string {
  const id = pageIds.get(notionId);
  if (!id) throw new Error("Channel pilot is missing a mapped Brain page id");
  return id;
}

function fixedPageIds(
  plan: NotionExecutionPlan,
): Map<string, string> {
  const generic = genericExecutionPlan(plan);
  return new Map(generic?.fixedPageIds ?? []);
}

function allPlanPagesMapped(
  plan: NotionExecutionPlan,
  pageIds: ReadonlyMap<string, string>,
): boolean {
  return plan.pages.every((page) => pageIds.has(page.notionId));
}

function assertUniqueMappedPageId(
  pageIds: ReadonlyMap<string, string>,
  notionId: string,
  pageId: string,
): void {
  for (const [mappedNotionId, mappedPageId] of pageIds) {
    if (mappedNotionId !== notionId && mappedPageId === pageId) {
      throw new ChannelPilotError(
        "destination_mapping_conflict",
        "Notion ids map to the same Brain page",
      );
    }
  }
}

function assertBrainId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Channel pilot received an invalid Brain page id");
  }
}

function validReservationToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

async function abortPage(
  page: NotionExecutionPage,
  reservationToken: string,
  options: ExecuteNotionExecutionOptions,
  runContext: RemoteRunContext,
): Promise<void> {
  await ensureRemoteMutationCapacity(options, runContext, "cleanup");
  const result = await options.client.abortPage({
    notionId: page.notionId,
    sourceHash: page.sourceHash,
    reservationToken,
  });
  await appendPageEventOnce(options.journal, {
    type: "page_aborted",
    notionId: page.notionId,
    sourceHash: page.sourceHash,
    reservationToken,
    pageId: result.pageId,
    status: result.status,
    stagingRemoved: result.cleanup.stagingRemoved,
    notionBindingRemoved: result.cleanup.notionBindingRemoved,
    placeholderPreserved: result.cleanup.placeholderPreserved,
  });
}

async function cleanupTerminalReservations(
  options: ExecuteNotionExecutionOptions,
  runContext: RemoteRunContext,
): Promise<{ attempted: number; aborted: number; failed: number }> {
  const result = { attempted: 0, aborted: 0, failed: 0 };
  for (const page of [...options.prepared.plan.pages].reverse()) {
    const preparedToken = options.journal.latest(
      "token_prepared",
      page.notionId,
    );
    if (
      preparedToken?.sourceHash !== page.sourceHash ||
      typeof preparedToken.reservationToken !== "string" ||
      !validReservationToken(preparedToken.reservationToken)
    ) {
      continue;
    }
    result.attempted += 1;
    try {
      const status = await options.client.findPage(page.notionId);
      if (
        !status?.importing ||
        status.importing.sourceHash !== page.sourceHash
      ) {
        continue;
      }
      await abortPage(
        page,
        preparedToken.reservationToken,
        options,
        runContext,
      );
      result.aborted += 1;
    } catch (error) {
      result.failed += 1;
      await appendPageEventOnce(options.journal, {
        type: "page_abort_failed",
        notionId: page.notionId,
        sourceHash: page.sourceHash,
        code: safeErrorCode(error),
      }).catch(() => undefined);
    }
  }
  return result;
}

async function reserveWithRetry(
  operation: () => ReturnType<BrainImportClient["reservePage"]>,
  options: ExecuteNotionExecutionOptions,
  onAttempt: () => Promise<void>,
): Promise<Awaited<ReturnType<BrainImportClient["reservePage"]>>> {
  const { maxAttempts, sleep } = retryPolicy(options);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await onAttempt();
    let result: Awaited<ReturnType<BrainImportClient["reservePage"]>>;
    try {
      result = await operation();
    } catch (error) {
      if (errorCode(error) !== "busy" || attempt === maxAttempts) throw error;
      await sleep(checkedRetryDelay(retryDelay(error)));
      continue;
    }
    if (result.status !== "busy") return result;
    if (attempt === maxAttempts) {
      throw new ChannelPilotError(
        "busy",
        "Channel pilot reservation remained busy",
        result.retryAfterMs,
      );
    }
    await sleep(checkedRetryDelay(result.retryAfterMs));
  }
  throw new ChannelPilotError("busy", "Channel pilot reservation remained busy");
}

async function retryBusy<T>(
  operation: () => Promise<T>,
  options: ExecuteNotionExecutionOptions,
  onAttempt: () => Promise<void>,
): Promise<T> {
  const { maxAttempts, sleep } = retryPolicy(options);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await onAttempt();
    try {
      return await operation();
    } catch (error) {
      const code = errorCode(error);
      if (
        (code !== "busy" && code !== "upload_busy") ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      await sleep(checkedRetryDelay(retryDelay(error)));
    }
  }
  throw new ChannelPilotError("busy", "Channel pilot retry budget exhausted");
}

function retryPolicy(options: ExecuteNotionExecutionOptions): {
  maxAttempts: number;
  sleep: (delayMs: number) => Promise<void>;
} {
  const maxAttempts = options.retry?.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("Channel pilot retry maxAttempts must be between 1 and 20");
  }
  return {
    maxAttempts,
    sleep:
      options.retry?.sleep ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
  };
}

function checkedRetryDelay(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isFinite(value) || value < 0 || value > 60 * 60 * 1_000) {
    throw new ChannelPilotError(
      "invalid_retry_delay",
      "Channel pilot received an invalid retry delay",
    );
  }
  return Math.max(1, Math.ceil(value));
}

function retryDelay(error: unknown): number | undefined {
  return error && typeof error === "object" && "retryAfterMs" in error
    ? (error as { retryAfterMs?: number }).retryAfterMs
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function safeErrorCode(error: unknown): string {
  return notionPilotErrorCode(error) ?? "indeterminate_failure";
}

function normalizeNotionId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function normalizeOptionalNotionId(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeNotionId(value) : undefined;
}

class ChannelPilotError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(messageCode: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ChannelPilotError";
    this.code = messageCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function isTerminalImportError(error: unknown): boolean {
  const code = errorCode(error);
  return !!code && new Set([
    "attachment_ack_mismatch",
    "attachment_not_owned",
    "attachment_readback_mismatch",
    "already_imported",
    "blocked_mime",
    "conversion_issues",
    "conversion_mismatch",
    "finalized_attachment_readback_mismatch",
    "hash_mismatch",
    "incompatible_cover",
    "incompatible_icon",
    "invalid_mime",
    "invalid_retry_delay",
    "journal_capacity",
    "mime_mismatch",
    "missing_attachment",
    "page_deleted",
    "parent_not_found",
    "quota_exceeded",
    "reservation_mismatch",
    "sibling_not_found",
    "source_changed",
    "too_large",
    "untracked_existing",
  ]).has(code);
}
