const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Releases cut by the release workflow are authored by github-actions[bot],
// so the login form GitHub gives App accounts (name[bot]) must pass.
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_RUN_AFTER_MERGE_MS = 5 * 60 * 1000;
const ASSOCIATED_PULLS_PER_PAGE = 100;
const MAX_ASSOCIATED_PULL_PAGES = 10;
const CANDIDATE_SCHEMA = 2;
const RELEASE_CANDIDATE_SCHEMA = 3;
const RELEASE_TAG_RE =
  /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/;
const MAX_CHECKSUMS_BYTES = 64 * 1024;

function reject(message) {
  throw new Error(message);
}

/** Current main is fine but its CI run has not finished yet. This is the
 *  normal ~10-minute window after every merge — a wait, not a failure. The
 *  resolver maps it to exit code 75 (EX_TEMPFAIL) so the puller can exit
 *  cleanly instead of tripping OnFailure= alerts every timer pass. */
export class CandidateNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.code = "candidate_not_ready";
  }
}

function exactRepository(value, expected, label) {
  if (value !== expected) reject(`${label} is not ${expected}`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    reject(`${label} is not a positive integer`);
  }
  return value;
}

function timestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const canonical = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : "";
  if (
    !TIMESTAMP_RE.test(value ?? "") ||
    !Number.isFinite(parsed) ||
    (value.includes(".") ? canonical : canonical.replace(".000Z", "Z")) !==
      value
  ) {
    reject(`${label} is not an ISO timestamp`);
  }
  return value;
}

function account(value, label) {
  const login = value?.login?.toLowerCase();
  const id = value?.id;
  if (!LOGIN_RE.test(login ?? "")) reject(`${label} login is invalid`);
  positiveInteger(id, `${label} id`);
  return { login, id };
}

function allowedAccount(allowedMergers, value, label) {
  const expectedId = allowedMergers.get(value.login);
  if (expectedId === undefined || expectedId !== value.id) {
    reject(`${label} is not the configured stable account`);
  }
  return value;
}

export function parseRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) {
    reject("BRAIN_DEPLOY_REPOSITORY must be owner/repository");
  }
  return value;
}

export function parseWorkflow(value) {
  if (typeof value !== "string" || !WORKFLOW_RE.test(value)) {
    reject("BRAIN_DEPLOY_WORKFLOW must be a workflow filename");
  }
  return value;
}

export function parseAllowedMergers(value) {
  if (typeof value !== "string") {
    reject("BRAIN_DEPLOY_ALLOWED_MERGERS is required");
  }
  const values = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) {
    reject("BRAIN_DEPLOY_ALLOWED_MERGERS must pin login:numericId accounts");
  }
  const configured = new Map();
  const ids = new Set();
  for (const entry of values) {
    const match = /^([a-z0-9-]{1,39}):([1-9][0-9]{0,15})$/.exec(entry);
    const id = match ? Number(match[2]) : Number.NaN;
    if (
      !match ||
      !LOGIN_RE.test(match[1]) ||
      !Number.isSafeInteger(id) ||
      configured.has(match[1]) ||
      ids.has(id)
    ) {
      reject(
        "BRAIN_DEPLOY_ALLOWED_MERGERS must contain unique login:numericId accounts",
      );
    }
    configured.set(match[1], id);
    ids.add(id);
  }
  return configured;
}

function validateRun(run, { repository, workflow, commit }) {
  if (!run || typeof run !== "object") reject("CI run is missing");
  positiveInteger(run.id, "CI run id");
  positiveInteger(run.run_attempt, "CI run attempt");
  positiveInteger(run.workflow_id, "CI workflow id");
  if (run.run_attempt !== 1) {
    reject("CI reruns are not deployable");
  }
  if (
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.head_sha !== commit ||
    run.head_commit?.id !== commit ||
    run.path !== `.github/workflows/${workflow}`
  ) {
    reject("CI run does not match the successful main-push contract");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    // A run that is still queued or executing is the expected state right
    // after a merge. Anything already concluded without success (failure,
    // cancelled, timed out) keeps the hard rejection: main is red and a
    // human should hear about it.
    if (run.status !== "completed" && run.conclusion === null) {
      throw new CandidateNotReadyError(
        "CI run for current main has not completed yet",
      );
    }
    reject("CI run does not match the successful main-push contract");
  }
  exactRepository(
    run.repository?.full_name,
    repository,
    "CI run repository",
  );
  exactRepository(
    run.head_repository?.full_name,
    repository,
    "CI head repository",
  );
  const repositoryId = positiveInteger(
    run.repository?.id,
    "CI run repository id",
  );
  const headRepositoryId = positiveInteger(
    run.head_repository?.id,
    "CI head repository id",
  );
  if (repositoryId !== headRepositoryId) {
    reject("CI run head repository id differs from the base repository");
  }
  timestamp(run.created_at, "CI run creation time");
  timestamp(run.run_started_at, "CI run attempt start time");
  if (Date.parse(run.run_started_at) < Date.parse(run.created_at)) {
    reject("CI run attempt starts before the run was created");
  }
  const actor = account(run.actor, "CI run actor");
  const triggeringActor = account(
    run.triggering_actor,
    "CI run triggering actor",
  );
  return {
    ...run,
    actorLogin: actor.login,
    actorId: actor.id,
    triggeringActorLogin: triggeringActor.login,
    triggeringActorId: triggeringActor.id,
    repositoryId,
    headRepositoryId,
  };
}

function validatePullRequestIdentity(pullRequest, { repository, commit }) {
  if (!pullRequest || typeof pullRequest !== "object") {
    reject("associated pull request is missing");
  }
  positiveInteger(pullRequest.number, "pull request number");
  if (
    pullRequest.state !== "closed" ||
    typeof pullRequest.merged_at !== "string" ||
    !pullRequest.merged_at ||
    pullRequest.merge_commit_sha !== commit ||
    pullRequest.base?.ref !== "main"
  ) {
    reject("pull request is not the exact merge that produced main");
  }
  exactRepository(
    pullRequest.base?.repo?.full_name,
    repository,
    "pull request base repository",
  );
  exactRepository(
    pullRequest.head?.repo?.full_name,
    repository,
    "pull request head repository",
  );
  const repositoryId = positiveInteger(
    pullRequest.base?.repo?.id,
    "pull request base repository id",
  );
  const headRepositoryId = positiveInteger(
    pullRequest.head?.repo?.id,
    "pull request head repository id",
  );
  if (repositoryId !== headRepositoryId) {
    reject("pull request head repository id differs from the base repository");
  }
  timestamp(pullRequest.merged_at, "pull request merge time");
  return { ...pullRequest, repositoryId, headRepositoryId };
}

function validatePullRequest(
  pullRequest,
  { repository, commit, allowedMergers },
) {
  const identified = validatePullRequestIdentity(pullRequest, {
    repository,
    commit,
  });
  const mergedBy = account(pullRequest.merged_by, "pull request merger");
  allowedAccount(allowedMergers, mergedBy, "pull request merger");
  return {
    ...identified,
    mergedBy: mergedBy.login,
    mergedById: mergedBy.id,
  };
}

function validateRunBinding(run, pullRequest, allowedMergers) {
  const runCreated = Date.parse(run.created_at);
  const runStarted = Date.parse(run.run_started_at);
  const mergedAt = Date.parse(pullRequest.merged_at);
  if (runCreated < mergedAt) {
    reject("CI run predates the pull request merge");
  }
  if (runCreated - mergedAt > MAX_RUN_AFTER_MERGE_MS) {
    reject("CI run was created too long after the pull request merge");
  }
  if (runStarted - mergedAt > MAX_RUN_AFTER_MERGE_MS) {
    reject("CI run attempt started too long after the pull request merge");
  }
  const actor = allowedAccount(
    allowedMergers,
    { login: run.actorLogin, id: run.actorId },
    "CI run actor",
  );
  const triggeringActor = allowedAccount(
    allowedMergers,
    {
      login: run.triggeringActorLogin,
      id: run.triggeringActorId,
    },
    "CI run triggering actor",
  );
  if (
    actor.id !== pullRequest.mergedById ||
    triggeringActor.id !== pullRequest.mergedById ||
    actor.login !== pullRequest.mergedBy ||
    triggeringActor.login !== pullRequest.mergedBy
  ) {
    reject("CI run actors are not the pull request merger");
  }
  if (run.repositoryId !== pullRequest.repositoryId) {
    reject("CI run repository id is not the pull request repository id");
  }
}

function validateArtifact(
  artifact,
  {
    commit,
    runId,
    runStartedAt,
    repositoryId,
    headRepositoryId,
    maxArtifactBytes = 512 * 1024 * 1024,
  },
) {
  if (!artifact || typeof artifact !== "object") reject("artifact is missing");
  timestamp(runStartedAt, "pinned run attempt start time");
  const expectedName = `brain-standalone-linux-x64-${commit}`;
  positiveInteger(artifact.id, "artifact id");
  positiveInteger(artifact.size_in_bytes, "artifact size");
  if (
    artifact.name !== expectedName ||
    artifact.expired !== false ||
    artifact.size_in_bytes > maxArtifactBytes ||
    !DIGEST_RE.test(artifact.digest ?? "")
  ) {
    reject("artifact does not match the pinned Linux x64 contract");
  }
  positiveInteger(repositoryId, "pinned repository id");
  positiveInteger(headRepositoryId, "pinned head repository id");
  const workflowRun = artifact.workflow_run;
  if (
    !workflowRun ||
    typeof workflowRun !== "object" ||
    workflowRun.id !== runId ||
    workflowRun.head_sha !== commit ||
    workflowRun.head_branch !== "main" ||
    workflowRun.repository_id !== repositoryId ||
    workflowRun.head_repository_id !== headRepositoryId
  ) {
    reject("artifact belongs to a different workflow run or repository");
  }
  timestamp(artifact.created_at, "artifact creation time");
  timestamp(artifact.expires_at, "artifact expiration time");
  if (Date.parse(artifact.created_at) < Date.parse(runStartedAt)) {
    reject("artifact predates the pinned workflow run attempt");
  }
  if (Date.parse(artifact.expires_at) <= Date.parse(artifact.created_at)) {
    reject("artifact expiration does not follow its creation time");
  }
  return artifact;
}

function validateMainRef(ref, repository) {
  const commit = ref?.object?.sha;
  if (!SHA_RE.test(commit ?? "")) reject("main ref did not return a commit SHA");
  if (ref.ref !== "refs/heads/main") reject("GitHub returned the wrong ref");
  if (ref.repository?.full_name !== undefined) {
    exactRepository(ref.repository.full_name, repository, "main ref repository");
  }
  return commit;
}

function workflowRunsPath(repository, workflow, commit = "") {
  const query = new URLSearchParams({
    branch: "main",
    event: "push",
    per_page: "100",
  });
  if (commit) query.set("head_sha", commit);
  return (
    `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?` +
    query.toString()
  );
}

function listedWorkflowRuns(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    !Array.isArray(value.workflow_runs)
  ) {
    reject(`${label} workflow run listing is invalid`);
  }
  return value.workflow_runs;
}

function sameRunIdentity(left, right) {
  return (
    left.id === right.id &&
    left.run_attempt === right.run_attempt &&
    left.workflow_id === right.workflow_id &&
    left.created_at === right.created_at &&
    left.run_started_at === right.run_started_at &&
    left.actorLogin === right.actorLogin &&
    left.actorId === right.actorId &&
    left.triggeringActorLogin === right.triggeringActorLogin &&
    left.triggeringActorId === right.triggeringActorId &&
    left.repositoryId === right.repositoryId &&
    left.headRepositoryId === right.headRepositoryId
  );
}

async function listAssociatedPullRequests({ api, repository, commit }) {
  const values = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_ASSOCIATED_PULL_PAGES; page += 1) {
    const batch = await api(
      `/repos/${repository}/commits/${commit}/pulls?` +
        new URLSearchParams({
          per_page: String(ASSOCIATED_PULLS_PER_PAGE),
          page: String(page),
        }).toString(),
    );
    if (!Array.isArray(batch)) {
      reject("associated pull request listing is invalid");
    }
    if (batch.length > ASSOCIATED_PULLS_PER_PAGE) {
      reject("associated pull request page exceeds the requested safety cap");
    }
    for (const pullRequest of batch) {
      const number = positiveInteger(
        pullRequest?.number,
        "associated pull request number",
      );
      if (seen.has(number)) {
        reject("associated pull request pagination returned a duplicate");
      }
      seen.add(number);
      values.push(pullRequest);
    }
    if (batch.length < ASSOCIATED_PULLS_PER_PAGE) return values;
  }
  reject("associated pull request listing exceeds the pagination safety cap");
}

function selectAssociatedPullRequest({ associated, repository, commit }) {
  const eligible = associated.flatMap((pullRequest) => {
    try {
      return [validatePullRequestIdentity(pullRequest, { repository, commit })];
    } catch {
      return [];
    }
  });
  if (eligible.length !== 1) {
    reject(
      "current main is not attributable to exactly one merged pull request",
    );
  }
  return eligible[0];
}

function exactArtifactListing(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.total_count !== 1 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== 1
  ) {
    reject("expected exactly one named artifact from the pinned CI run");
  }
  return value.artifacts[0];
}

function selectCurrentRun({
  overallListing,
  commitListing,
  repository,
  workflow,
  commit,
}) {
  const overallRuns = listedWorkflowRuns(overallListing, "overall");
  const commitRuns = listedWorkflowRuns(commitListing, "commit");
  if (overallRuns.length < 1) {
    reject("current main has no CI workflow run");
  }
  if (commitListing.total_count !== 1 || commitRuns.length !== 1) {
    reject("expected exactly one all-status CI run for current main");
  }
  const run = validateRun(commitRuns[0], { repository, workflow, commit });
  const newest = validateRun(overallRuns[0], { repository, workflow, commit });
  if (newest.id !== run.id) {
    reject("current main CI run is not the newest workflow run");
  }
  if (!sameRunIdentity(newest, run)) {
    reject("workflow run listings disagree about current main");
  }
  return run;
}

export async function currentMainCommit({ api, repository }) {
  parseRepository(repository);
  return validateMainRef(
    await api(`/repos/${repository}/git/ref/heads/main`),
    repository,
  );
}

export async function assertForwardCandidate({
  api,
  repository,
  minimumCommit,
  commit,
}) {
  parseRepository(repository);
  if (!SHA_RE.test(minimumCommit ?? "") || !SHA_RE.test(commit ?? "")) {
    reject("deployment ancestry commits are invalid");
  }
  if (minimumCommit === commit) return commit;
  const comparison = await api(
    `/repos/${repository}/compare/${minimumCommit}...${commit}`,
  );
  if (
    comparison?.status !== "ahead" ||
    comparison?.base_commit?.sha !== minimumCommit ||
    comparison?.merge_base_commit?.sha !== minimumCommit ||
    !Number.isSafeInteger(comparison?.ahead_by) ||
    comparison.ahead_by < 1 ||
    comparison?.behind_by !== 0
  ) {
    reject("current main is not a forward descendant of the active release");
  }
  return commit;
}

function candidateFrom({
  repository,
  workflow,
  minimumCommit,
  commit,
  pullRequest,
  run,
  artifact,
}) {
  return validateCandidate({
    schema: CANDIDATE_SCHEMA,
    repository,
    repositoryId: run.repositoryId,
    branch: "main",
    minimumCommit,
    commit,
    pullRequest: {
      number: pullRequest.number,
      mergedAt: pullRequest.merged_at,
      mergedBy: pullRequest.mergedBy,
      mergedById: pullRequest.mergedById,
      headRepository: pullRequest.head.repo.full_name,
      baseRepositoryId: pullRequest.repositoryId,
      headRepositoryId: pullRequest.headRepositoryId,
    },
    workflow: {
      file: workflow,
      workflowId: run.workflow_id,
      runId: run.id,
      runAttempt: run.run_attempt,
      createdAt: run.created_at,
      startedAt: run.run_started_at,
      actor: run.actorLogin,
      actorId: run.actorId,
      triggeringActor: run.triggeringActorLogin,
      triggeringActorId: run.triggeringActorId,
      repositoryId: run.repositoryId,
      headRepositoryId: run.headRepositoryId,
    },
    artifact: {
      id: artifact.id,
      name: artifact.name,
      sizeInBytes: artifact.size_in_bytes,
      digest: artifact.digest,
      createdAt: artifact.created_at,
      expiresAt: artifact.expires_at,
      workflowRunId: artifact.workflow_run.id,
      workflowHeadSha: artifact.workflow_run.head_sha,
      workflowHeadBranch: artifact.workflow_run.head_branch,
      repositoryId: artifact.workflow_run.repository_id,
      headRepositoryId: artifact.workflow_run.head_repository_id,
    },
    resolvedAt: new Date().toISOString(),
  });
}

function validateCiCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.schema !== CANDIDATE_SCHEMA
  ) {
    reject("candidate schema is invalid");
  }
  parseRepository(candidate.repository);
  parseWorkflow(candidate.workflow?.file);
  const repositoryId = positiveInteger(
    candidate.repositoryId,
    "candidate repository id",
  );
  if (candidate.branch !== "main" || !SHA_RE.test(candidate.commit ?? "")) {
    reject("candidate branch or commit is invalid");
  }
  if (!SHA_RE.test(candidate.minimumCommit ?? "")) {
    reject("candidate minimum commit is invalid");
  }
  positiveInteger(candidate.pullRequest?.number, "candidate pull request");
  const mergedById = positiveInteger(
    candidate.pullRequest?.mergedById,
    "candidate pull request merger",
  );
  const pullBaseRepositoryId = positiveInteger(
    candidate.pullRequest?.baseRepositoryId,
    "candidate pull request base repository id",
  );
  const pullHeadRepositoryId = positiveInteger(
    candidate.pullRequest?.headRepositoryId,
    "candidate pull request head repository id",
  );
  if (
    typeof candidate.pullRequest?.mergedAt !== "string" ||
    !candidate.pullRequest.mergedAt ||
    !LOGIN_RE.test(candidate.pullRequest?.mergedBy ?? "") ||
    candidate.pullRequest?.headRepository !== candidate.repository ||
    pullBaseRepositoryId !== repositoryId ||
    pullHeadRepositoryId !== repositoryId
  ) {
    reject("candidate pull request provenance is invalid");
  }
  timestamp(candidate.pullRequest.mergedAt, "candidate pull request merge time");
  positiveInteger(candidate.workflow?.workflowId, "candidate workflow id");
  positiveInteger(candidate.workflow?.runId, "candidate run id");
  if (candidate.workflow?.runAttempt !== 1) {
    reject("candidate workflow attempt is not the first attempt");
  }
  const actorId = positiveInteger(
    candidate.workflow?.actorId,
    "candidate workflow actor",
  );
  const triggeringActorId = positiveInteger(
    candidate.workflow?.triggeringActorId,
    "candidate workflow triggering actor",
  );
  const workflowRepositoryId = positiveInteger(
    candidate.workflow?.repositoryId,
    "candidate workflow repository id",
  );
  const workflowHeadRepositoryId = positiveInteger(
    candidate.workflow?.headRepositoryId,
    "candidate workflow head repository id",
  );
  if (
    !LOGIN_RE.test(candidate.workflow?.actor ?? "") ||
    !LOGIN_RE.test(candidate.workflow?.triggeringActor ?? "") ||
    actorId !== mergedById ||
    triggeringActorId !== mergedById ||
    candidate.workflow.actor !== candidate.pullRequest.mergedBy ||
    candidate.workflow.triggeringActor !== candidate.pullRequest.mergedBy ||
    workflowRepositoryId !== repositoryId ||
    workflowHeadRepositoryId !== repositoryId
  ) {
    reject("candidate workflow actor or repository provenance is invalid");
  }
  timestamp(candidate.workflow?.createdAt, "candidate run creation time");
  timestamp(candidate.workflow?.startedAt, "candidate run attempt start time");
  const mergedAt = Date.parse(candidate.pullRequest.mergedAt);
  const runCreatedAt = Date.parse(candidate.workflow.createdAt);
  const runStartedAt = Date.parse(candidate.workflow.startedAt);
  if (
    runCreatedAt < mergedAt ||
    runStartedAt < runCreatedAt ||
    runCreatedAt - mergedAt > MAX_RUN_AFTER_MERGE_MS ||
    runStartedAt - mergedAt > MAX_RUN_AFTER_MERGE_MS
  ) {
    reject("candidate workflow timing provenance is invalid");
  }
  positiveInteger(candidate.artifact?.id, "candidate artifact id");
  positiveInteger(candidate.artifact?.sizeInBytes, "candidate artifact size");
  timestamp(candidate.artifact?.createdAt, "candidate artifact creation time");
  timestamp(candidate.artifact?.expiresAt, "candidate artifact expiration time");
  const artifactRepositoryId = positiveInteger(
    candidate.artifact?.repositoryId,
    "candidate artifact repository id",
  );
  const artifactHeadRepositoryId = positiveInteger(
    candidate.artifact?.headRepositoryId,
    "candidate artifact head repository id",
  );
  if (
    Date.parse(candidate.artifact.createdAt) < runStartedAt ||
    Date.parse(candidate.artifact.expiresAt) <=
      Date.parse(candidate.artifact.createdAt)
  ) {
    reject("candidate artifact timing provenance is invalid");
  }
  if (
    candidate.artifact?.name !==
      `brain-standalone-linux-x64-${candidate.commit}` ||
    !DIGEST_RE.test(candidate.artifact?.digest ?? "") ||
    candidate.artifact?.workflowRunId !== candidate.workflow.runId ||
    candidate.artifact?.workflowHeadSha !== candidate.commit ||
    candidate.artifact?.workflowHeadBranch !== "main" ||
    artifactRepositoryId !== repositoryId ||
    artifactHeadRepositoryId !== repositoryId ||
    !candidate.resolvedAt
  ) {
    reject("candidate artifact provenance is invalid");
  }
  timestamp(candidate.resolvedAt, "candidate resolution time");
  if (
    Date.parse(candidate.resolvedAt) < Date.parse(candidate.artifact.createdAt) ||
    Date.parse(candidate.resolvedAt) >= Date.parse(candidate.artifact.expiresAt)
  ) {
    reject("candidate resolution falls outside the artifact lifetime");
  }
  return candidate;
}

export async function resolveCandidate({
  api,
  repository,
  workflow,
  minimumCommit,
  allowedMergers,
  maxArtifactBytes,
}) {
  parseRepository(repository);
  parseWorkflow(workflow);
  if (!SHA_RE.test(minimumCommit ?? "")) {
    reject("minimum active release commit is invalid");
  }

  const commit = await currentMainCommit({ api, repository });
  await assertForwardCandidate({ api, repository, minimumCommit, commit });
  const [overallRuns, commitRuns] = await Promise.all([
    api(workflowRunsPath(repository, workflow)),
    api(workflowRunsPath(repository, workflow, commit)),
  ]);
  const run = selectCurrentRun({
    overallListing: overallRuns,
    commitListing: commitRuns,
    repository,
    workflow,
    commit,
  });

  const associated = await listAssociatedPullRequests({
    api,
    repository,
    commit,
  });
  const associatedPullRequest = selectAssociatedPullRequest({
    associated,
    repository,
    commit,
  });
  const fullPullRequest = await api(
    `/repos/${repository}/pulls/${associatedPullRequest.number}`,
  );
  const pullRequest = validatePullRequest(fullPullRequest, {
    repository,
    commit,
    allowedMergers,
  });
  if (pullRequest.number !== associatedPullRequest.number) {
    reject("full pull request does not match the associated pull request");
  }
  validateRunBinding(run, pullRequest, allowedMergers);

  const artifactName = `brain-standalone-linux-x64-${commit}`;
  const artifacts = await api(
    `/repos/${repository}/actions/runs/${run.id}/artifacts?` +
      new URLSearchParams({
        name: artifactName,
        per_page: "100",
      }).toString(),
  );
  const artifact = validateArtifact(exactArtifactListing(artifacts), {
    commit,
    runId: run.id,
    runStartedAt: run.run_started_at,
    repositoryId: run.repositoryId,
    headRepositoryId: run.headRepositoryId,
    maxArtifactBytes,
  });

  return candidateFrom({
    repository,
    workflow,
    minimumCommit,
    commit,
    pullRequest,
    run,
    artifact,
  });
}

export async function recheckCandidate({
  api,
  candidate,
  allowedMergers,
  maxArtifactBytes,
  verifyArtifact = true,
}) {
  validateCandidate(candidate);
  const { repository, commit } = candidate;
  allowedAccount(
    allowedMergers,
    {
      login: candidate.pullRequest.mergedBy.toLowerCase(),
      id: candidate.pullRequest.mergedById,
    },
    "candidate merger",
  );

  const [ref, rawRun, pullRequest, overallRuns, commitRuns, associated] =
    await Promise.all([
      api(`/repos/${repository}/git/ref/heads/main`),
      api(`/repos/${repository}/actions/runs/${candidate.workflow.runId}`),
      api(`/repos/${repository}/pulls/${candidate.pullRequest.number}`),
      api(workflowRunsPath(repository, candidate.workflow.file)),
      api(workflowRunsPath(repository, candidate.workflow.file, commit)),
      listAssociatedPullRequests({ api, repository, commit }),
    ]);
  if (validateMainRef(ref, repository) !== commit) {
    reject("main advanced after candidate resolution");
  }
  await assertForwardCandidate({
    api,
    repository,
    minimumCommit: candidate.minimumCommit,
    commit,
  });
  const run = validateRun(rawRun, {
    repository,
    workflow: candidate.workflow.file,
    commit,
  });
  const listedRun = selectCurrentRun({
    overallListing: overallRuns,
    commitListing: commitRuns,
    repository,
    workflow: candidate.workflow.file,
    commit,
  });
  if (
    run.id !== candidate.workflow.runId ||
    run.run_attempt !== candidate.workflow.runAttempt ||
    run.workflow_id !== candidate.workflow.workflowId ||
    run.created_at !== candidate.workflow.createdAt ||
    run.run_started_at !== candidate.workflow.startedAt ||
    run.actorLogin !== candidate.workflow.actor ||
    run.actorId !== candidate.workflow.actorId ||
    run.triggeringActorLogin !== candidate.workflow.triggeringActor ||
    run.triggeringActorId !== candidate.workflow.triggeringActorId ||
    run.repositoryId !== candidate.workflow.repositoryId ||
    run.headRepositoryId !== candidate.workflow.headRepositoryId
  ) {
    reject("CI run identity changed after candidate resolution");
  }
  if (!sameRunIdentity(listedRun, run)) {
    reject("listed CI run changed after candidate resolution");
  }
  const associatedPullRequest = selectAssociatedPullRequest({
    associated,
    repository,
    commit,
  });
  if (
    associatedPullRequest.number !== candidate.pullRequest.number ||
    associatedPullRequest.merged_at !== candidate.pullRequest.mergedAt ||
    associatedPullRequest.repositoryId !==
      candidate.pullRequest.baseRepositoryId ||
    associatedPullRequest.headRepositoryId !==
      candidate.pullRequest.headRepositoryId
  ) {
    reject("associated pull request changed after candidate resolution");
  }
  const checkedPullRequest = validatePullRequest(pullRequest, {
    repository,
    commit,
    allowedMergers,
  });
  if (
    checkedPullRequest.number !== candidate.pullRequest.number ||
    checkedPullRequest.merged_at !== candidate.pullRequest.mergedAt ||
    checkedPullRequest.mergedBy !== candidate.pullRequest.mergedBy ||
    checkedPullRequest.mergedById !== candidate.pullRequest.mergedById ||
    checkedPullRequest.repositoryId !==
      candidate.pullRequest.baseRepositoryId ||
    checkedPullRequest.headRepositoryId !==
      candidate.pullRequest.headRepositoryId
  ) {
    reject("pull request provenance changed after candidate resolution");
  }
  validateRunBinding(run, checkedPullRequest, allowedMergers);
  if (!verifyArtifact) return candidate;
  const artifact = await api(
    `/repos/${repository}/actions/artifacts/${candidate.artifact.id}`,
  );
  validateArtifact(artifact, {
    commit,
    runId: candidate.workflow.runId,
    runStartedAt: candidate.workflow.startedAt,
    repositoryId: candidate.workflow.repositoryId,
    headRepositoryId: candidate.workflow.headRepositoryId,
    maxArtifactBytes,
  });
  if (
    artifact.id !== candidate.artifact.id ||
    artifact.name !== candidate.artifact.name ||
    artifact.size_in_bytes !== candidate.artifact.sizeInBytes ||
    artifact.digest !== candidate.artifact.digest ||
    artifact.created_at !== candidate.artifact.createdAt ||
    artifact.expires_at !== candidate.artifact.expiresAt ||
    artifact.workflow_run.id !== candidate.artifact.workflowRunId ||
    artifact.workflow_run.head_sha !== candidate.artifact.workflowHeadSha ||
    artifact.workflow_run.head_branch !==
      candidate.artifact.workflowHeadBranch ||
    artifact.workflow_run.repository_id !== candidate.artifact.repositoryId ||
    artifact.workflow_run.head_repository_id !==
      candidate.artifact.headRepositoryId
  ) {
    reject("artifact identity changed after candidate resolution");
  }
  return candidate;
}

export function parseDeploySource(value) {
  if (value === undefined) return "ci";
  if (value !== "ci" && value !== "release") {
    reject("BRAIN_DEPLOY_SOURCE must be ci or release");
  }
  return value;
}

export function parseReleaseTag(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !RELEASE_TAG_RE.test(value)) {
    reject("BRAIN_DEPLOY_RELEASE_TAG must be a v<semver> tag");
  }
  return value;
}

export function tarballAssetName(version) {
  return `brain-${version}-linux-x64.tar.gz`;
}

export function candidateKind(candidate) {
  return candidate?.schema === RELEASE_CANDIDATE_SCHEMA ? "release" : "ci";
}

function validateReleaseAsset(asset, { name, maxBytes, label }) {
  if (!asset || typeof asset !== "object") reject(`${label} asset is missing`);
  positiveInteger(asset.id, `${label} asset id`);
  positiveInteger(asset.size, `${label} asset size`);
  if (
    asset.name !== name ||
    asset.state !== "uploaded" ||
    asset.size > maxBytes
  ) {
    reject(`${label} asset does not match the release contract`);
  }
  return { id: asset.id, name: asset.name, sizeInBytes: asset.size };
}

function validateRelease(release, { maxArtifactBytes, expectedTag, allowPrerelease }) {
  if (!release || typeof release !== "object") reject("release is missing");
  positiveInteger(release.id, "release id");
  const match = RELEASE_TAG_RE.exec(release.tag_name ?? "");
  if (!match) reject("release tag is not a v<semver> tag");
  if (expectedTag !== null && release.tag_name !== expectedTag) {
    reject("release tag does not match the pinned tag");
  }
  if (release.draft !== false) reject("release is a draft");
  if (typeof release.prerelease !== "boolean") {
    reject("release pre-release flag is invalid");
  }
  if (release.prerelease && !allowPrerelease) {
    reject("latest release is a pre-release");
  }
  timestamp(release.published_at, "release publication time");
  const author = account(release.author, "release author");
  const version = match[1];
  if (!Array.isArray(release.assets)) reject("release assets are missing");
  const named = (name) =>
    release.assets.filter((asset) => asset?.name === name);
  if (
    named(tarballAssetName(version)).length !== 1 ||
    named("SHA256SUMS").length !== 1
  ) {
    reject("release must carry exactly one tarball and one SHA256SUMS");
  }
  return {
    id: release.id,
    tagName: release.tag_name,
    version,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    author: author.login,
    authorId: author.id,
    tarball: validateReleaseAsset(named(tarballAssetName(version))[0], {
      name: tarballAssetName(version),
      maxBytes: maxArtifactBytes,
      label: "tarball",
    }),
    checksums: validateReleaseAsset(named("SHA256SUMS")[0], {
      name: "SHA256SUMS",
      maxBytes: MAX_CHECKSUMS_BYTES,
      label: "checksums",
    }),
  };
}

async function releaseTagCommit({ api, repository, tagName }) {
  const ref = await api(
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(tagName)}`,
  );
  if (ref?.ref !== `refs/tags/${tagName}`) {
    reject("GitHub returned the wrong tag ref");
  }
  let object = ref.object;
  if (object?.type === "tag") {
    if (!SHA_RE.test(object.sha ?? "")) {
      reject("annotated tag object SHA is invalid");
    }
    const tag = await api(`/repos/${repository}/git/tags/${object.sha}`);
    if (tag?.tag !== tagName) {
      reject("annotated tag does not name the release tag");
    }
    object = tag.object;
  }
  if (object?.type !== "commit" || !SHA_RE.test(object.sha ?? "")) {
    reject("release tag does not resolve to a commit");
  }
  return object.sha;
}

async function fetchTargetRelease({ api, repository, releaseTag }) {
  if (releaseTag !== null) {
    const pinned = await api(
      `/repos/${repository}/releases/tags/${encodeURIComponent(releaseTag)}`,
      { allowMissing: true },
    );
    if (pinned === null) {
      throw new CandidateNotReadyError(
        `pinned release ${releaseTag} is not published yet`,
      );
    }
    return pinned;
  }
  const latest = await api(`/repos/${repository}/releases/latest`, {
    allowMissing: true,
  });
  if (latest === null) {
    throw new CandidateNotReadyError("no published release yet");
  }
  return latest;
}

export async function releaseTargetCommit({
  api,
  repository,
  releaseTag,
  maxArtifactBytes,
}) {
  parseRepository(repository);
  const raw = await fetchTargetRelease({ api, repository, releaseTag });
  const release = validateRelease(raw, {
    maxArtifactBytes,
    expectedTag: releaseTag,
    allowPrerelease: releaseTag !== null,
  });
  return releaseTagCommit({ api, repository, tagName: release.tagName });
}

export async function resolveReleaseCandidate({
  api,
  repository,
  minimumCommit,
  releaseTag,
  maxArtifactBytes,
}) {
  parseRepository(repository);
  if (!SHA_RE.test(minimumCommit ?? "")) {
    reject("minimum active release commit is invalid");
  }
  const raw = await fetchTargetRelease({ api, repository, releaseTag });
  const release = validateRelease(raw, {
    maxArtifactBytes,
    expectedTag: releaseTag,
    allowPrerelease: releaseTag !== null,
  });
  const commit = await releaseTagCommit({
    api,
    repository,
    tagName: release.tagName,
  });
  await assertForwardCandidate({ api, repository, minimumCommit, commit });
  const repositoryId = positiveInteger(
    (await api(`/repos/${repository}`))?.id,
    "repository id",
  );
  return validateReleaseCandidate({
    schema: RELEASE_CANDIDATE_SCHEMA,
    kind: "release",
    repository,
    repositoryId,
    minimumCommit,
    commit,
    release: {
      id: release.id,
      tagName: release.tagName,
      version: release.version,
      prerelease: release.prerelease,
      pinned: releaseTag !== null,
      publishedAt: release.publishedAt,
      author: release.author,
      authorId: release.authorId,
    },
    assets: { tarball: release.tarball, checksums: release.checksums },
    resolvedAt: new Date().toISOString(),
  });
}

export function validateReleaseCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.schema !== RELEASE_CANDIDATE_SCHEMA ||
    candidate.kind !== "release"
  ) {
    reject("release candidate schema is invalid");
  }
  parseRepository(candidate.repository);
  positiveInteger(candidate.repositoryId, "candidate repository id");
  if (
    !SHA_RE.test(candidate.commit ?? "") ||
    !SHA_RE.test(candidate.minimumCommit ?? "")
  ) {
    reject("candidate commits are invalid");
  }
  const release = candidate.release;
  positiveInteger(release?.id, "candidate release id");
  const match = RELEASE_TAG_RE.exec(release?.tagName ?? "");
  if (
    !match ||
    release.version !== match[1] ||
    typeof release.prerelease !== "boolean" ||
    typeof release.pinned !== "boolean" ||
    !LOGIN_RE.test(release.author ?? "")
  ) {
    reject("candidate release provenance is invalid");
  }
  if (release.prerelease && !release.pinned) {
    reject("an unpinned pre-release is never deployable");
  }
  positiveInteger(release.authorId, "candidate release author id");
  timestamp(release.publishedAt, "candidate release publication time");
  const tarball = candidate.assets?.tarball;
  const checksums = candidate.assets?.checksums;
  positiveInteger(tarball?.id, "candidate tarball asset id");
  positiveInteger(tarball?.sizeInBytes, "candidate tarball size");
  positiveInteger(checksums?.id, "candidate checksums asset id");
  positiveInteger(checksums?.sizeInBytes, "candidate checksums size");
  if (
    tarball.name !== tarballAssetName(release.version) ||
    checksums.name !== "SHA256SUMS" ||
    checksums.sizeInBytes > MAX_CHECKSUMS_BYTES
  ) {
    reject("candidate release assets are invalid");
  }
  timestamp(candidate.resolvedAt, "candidate resolution time");
  if (Date.parse(candidate.resolvedAt) < Date.parse(release.publishedAt)) {
    reject("candidate resolution predates the release publication");
  }
  return candidate;
}

export function validateCandidate(candidate) {
  return candidateKind(candidate) === "release"
    ? validateReleaseCandidate(candidate)
    : validateCiCandidate(candidate);
}

export async function recheckReleaseCandidate({
  api,
  candidate,
  maxArtifactBytes,
}) {
  validateReleaseCandidate(candidate);
  const { repository, commit } = candidate;
  const [byId, target] = await Promise.all([
    api(`/repos/${repository}/releases/${candidate.release.id}`),
    fetchTargetRelease({
      api,
      repository,
      releaseTag: candidate.release.pinned ? candidate.release.tagName : null,
    }),
  ]);
  const current = validateRelease(byId, {
    maxArtifactBytes,
    expectedTag: candidate.release.tagName,
    allowPrerelease: candidate.release.pinned,
  });
  if (target?.id !== candidate.release.id) {
    reject(
      "another release became the deployment target after candidate resolution",
    );
  }
  if (
    current.id !== candidate.release.id ||
    current.publishedAt !== candidate.release.publishedAt ||
    current.prerelease !== candidate.release.prerelease ||
    current.authorId !== candidate.release.authorId ||
    current.tarball.id !== candidate.assets.tarball.id ||
    current.tarball.sizeInBytes !== candidate.assets.tarball.sizeInBytes ||
    current.checksums.id !== candidate.assets.checksums.id ||
    current.checksums.sizeInBytes !== candidate.assets.checksums.sizeInBytes
  ) {
    reject("release identity changed after candidate resolution");
  }
  const tagCommit = await releaseTagCommit({
    api,
    repository,
    tagName: candidate.release.tagName,
  });
  if (tagCommit !== commit) {
    reject("release tag moved after candidate resolution");
  }
  await assertForwardCandidate({
    api,
    repository,
    minimumCommit: candidate.minimumCommit,
    commit,
  });
  return candidate;
}

export const internals = {
  validateArtifact,
  validateMainRef,
  validatePullRequest,
  validatePullRequestIdentity,
  validateRun,
  validateRunBinding,
  workflowRunsPath,
};
