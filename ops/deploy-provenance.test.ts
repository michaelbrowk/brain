import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseAllowedMergers,
  parseDeploySource,
  parseReleaseTag,
  recheckCandidate,
  recheckReleaseCandidate,
  releaseTargetCommit,
  resolveCandidate,
  resolveReleaseCandidate,
  validateCandidate,
  validateReleaseCandidate,
} from "./deploy-provenance.mjs";

const repository = "michaelbrowk/brain";
const workflow = "ci.yml";
const commit = "a".repeat(40);
const minimumCommit = "0".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const repositoryId = 1_296_646_939;
const mergerId = 42;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:01:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  const ref = { ref: "refs/heads/main", object: { sha: commit } };
  const run = {
    id: 101,
    run_attempt: 1,
    workflow_id: 11,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: commit,
    head_commit: { id: commit },
    path: ".github/workflows/ci.yml",
    created_at: "2026-07-12T10:00:01Z",
    run_started_at: "2026-07-12T10:00:02Z",
    repository: { full_name: repository, id: repositoryId },
    head_repository: { full_name: repository, id: repositoryId },
    actor: { login: "MichaelBrowk", id: mergerId },
    triggering_actor: { login: "MichaelBrowk", id: mergerId },
  };
  const pullRequest = {
    number: 7,
    state: "closed",
    merged_at: "2026-07-12T10:00:00Z",
    merge_commit_sha: commit,
    merged_by: { login: "MichaelBrowk", id: mergerId },
    base: { ref: "main", repo: { full_name: repository, id: repositoryId } },
    head: {
      ref: "codex/change",
      repo: { full_name: repository, id: repositoryId },
    },
  };
  const artifact = {
    id: 501,
    name: `brain-standalone-linux-x64-${commit}`,
    size_in_bytes: 4096,
    expired: false,
    digest,
    created_at: "2026-07-12T10:00:03Z",
    expires_at: "2026-07-26T10:00:03Z",
    workflow_run: {
      id: run.id,
      head_sha: commit,
      head_branch: "main",
      repository_id: repositoryId,
      head_repository_id: repositoryId,
    },
  };
  const comparison = {
    status: "ahead",
    base_commit: { sha: minimumCommit },
    merge_base_commit: { sha: minimumCommit },
    ahead_by: 1,
    behind_by: 0,
  };
  return {
    ref,
    run,
    pullRequest,
    artifact,
    comparison,
    overallRuns: [run],
    commitRuns: [run],
  };
}

function resolverApi(values = fixture()) {
  return async (path: string) => {
    if (path.endsWith("/git/ref/heads/main")) return values.ref;
    if (path.includes("/compare/")) return values.comparison;
    if (path.includes("/actions/workflows/")) {
      const workflowRuns = path.includes("head_sha=")
        ? values.commitRuns
        : values.overallRuns;
      return { total_count: workflowRuns.length, workflow_runs: workflowRuns };
    }
    if (path.includes(`/commits/${commit}/pulls`)) {
      const summary = { ...values.pullRequest };
      Reflect.deleteProperty(summary, "merged_by");
      return [summary];
    }
    if (path.endsWith(`/pulls/${values.pullRequest.number}`)) {
      return values.pullRequest;
    }
    if (path.includes(`/actions/runs/${values.run.id}/artifacts`)) {
      return { total_count: 1, artifacts: [values.artifact] };
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

function recheckApi(values = fixture()) {
  return async (path: string) => {
    if (path.endsWith("/git/ref/heads/main")) return values.ref;
    if (path.includes("/compare/")) return values.comparison;
    if (path.includes("/actions/workflows/")) {
      const workflowRuns = path.includes("head_sha=")
        ? values.commitRuns
        : values.overallRuns;
      return { total_count: workflowRuns.length, workflow_runs: workflowRuns };
    }
    if (path.endsWith(`/actions/runs/${values.run.id}`)) return values.run;
    if (path.endsWith(`/pulls/${values.pullRequest.number}`)) {
      return values.pullRequest;
    }
    if (path.includes(`/commits/${commit}/pulls`)) {
      const summary = { ...values.pullRequest };
      Reflect.deleteProperty(summary, "merged_by");
      return [summary];
    }
    if (path.endsWith(`/actions/artifacts/${values.artifact.id}`)) {
      return values.artifact;
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

const options = {
  repository,
  workflow,
  minimumCommit,
  allowedMergers: parseAllowedMergers(`michaelbrowk:${mergerId}`),
  maxArtifactBytes: 1024 * 1024,
};

describe("deploy provenance", () => {
  it("requires stable login:numericId merger configuration", () => {
    expect(() => parseAllowedMergers("michaelbrowk")).toThrow(
      "login:numericId",
    );
    expect(() =>
      parseAllowedMergers("michaelbrowk:42,other-user:42"),
    ).toThrow("unique");
    expect(parseAllowedMergers("MichaelBrowk:42").get("michaelbrowk")).toBe(
      42,
    );
  });

  it("requires the complete v2 schema and canonical provenance timestamps", async () => {
    const candidate = await resolveCandidate({ api: resolverApi(), ...options });
    expect(() => validateCandidate({ ...candidate, schema: 1 })).toThrow(
      "schema",
    );
    expect(() =>
      validateCandidate({
        ...candidate,
        pullRequest: {
          ...candidate.pullRequest,
          mergedAt: "2026-02-30T10:00:00Z",
        },
      }),
    ).toThrow("ISO timestamp");
    expect(() =>
      validateCandidate({
        ...candidate,
        resolvedAt: candidate.artifact.expiresAt,
      }),
    ).toThrow("artifact lifetime");
  });

  it("treats a still-running CI run as not-ready, not a contract violation", async () => {
    const pending = fixture();
    pending.run = {
      ...pending.run,
      status: "in_progress",
      conclusion: null as unknown as string,
    };
    pending.overallRuns = [pending.run];
    pending.commitRuns = [pending.run];
    await expect(
      resolveCandidate({ api: resolverApi(pending), ...options }),
    ).rejects.toMatchObject({
      code: "candidate_not_ready",
    });

    const red = fixture();
    red.run = { ...red.run, status: "completed", conclusion: "failure" };
    red.overallRuns = [red.run];
    red.commitRuns = [red.run];
    await expect(
      resolveCandidate({ api: resolverApi(red), ...options }),
    ).rejects.toThrow("successful main-push contract");

    const cancelled = fixture();
    cancelled.run = { ...cancelled.run, status: "completed", conclusion: "cancelled" };
    cancelled.overallRuns = [cancelled.run];
    cancelled.commitRuns = [cancelled.run];
    await expect(
      resolveCandidate({ api: resolverApi(cancelled), ...options }),
    ).rejects.toThrow("successful main-push contract");
  });

  it("pins the exact same-repo PR, CI attempt, and artifact", async () => {
    const candidate = await resolveCandidate({ api: resolverApi(), ...options });

    expect(candidate).toMatchObject({
      schema: 2,
      repository,
      repositoryId,
      branch: "main",
      minimumCommit,
      commit,
      pullRequest: {
        number: 7,
        mergedBy: "michaelbrowk",
        mergedById: mergerId,
        baseRepositoryId: repositoryId,
        headRepositoryId: repositoryId,
        headRepository: repository,
      },
      workflow: {
        workflowId: 11,
        runId: 101,
        runAttempt: 1,
        createdAt: "2026-07-12T10:00:01Z",
        startedAt: "2026-07-12T10:00:02Z",
        actor: "michaelbrowk",
        actorId: mergerId,
        triggeringActor: "michaelbrowk",
        triggeringActorId: mergerId,
        repositoryId,
        headRepositoryId: repositoryId,
      },
      artifact: {
        id: 501,
        digest,
        createdAt: "2026-07-12T10:00:03Z",
        expiresAt: "2026-07-26T10:00:03Z",
        workflowRunId: 101,
        workflowHeadSha: commit,
        workflowHeadBranch: "main",
        repositoryId,
        headRepositoryId: repositoryId,
      },
    });
    await expect(
      recheckCandidate({ api: recheckApi(), candidate, ...options }),
    ).resolves.toBe(candidate);
  });

  it("uses all-status newest and exact-SHA listings during resolve and recheck", async () => {
    const resolvePaths: string[] = [];
    const candidate = await resolveCandidate({
      api: async (path: string) => {
        resolvePaths.push(path);
        return resolverApi()(path);
      },
      ...options,
    });
    const resolveListings = resolvePaths.filter((path) =>
      path.includes("/actions/workflows/"),
    );
    expect(resolveListings).toHaveLength(2);
    expect(resolveListings.every((path) => !path.includes("status="))).toBe(true);
    expect(resolveListings.filter((path) => path.includes("head_sha="))).toHaveLength(1);

    const recheckPaths: string[] = [];
    await recheckCandidate({
      api: async (path: string) => {
        recheckPaths.push(path);
        return recheckApi()(path);
      },
      candidate,
      ...options,
    });
    const recheckListings = recheckPaths.filter((path) =>
      path.includes("/actions/workflows/"),
    );
    expect(recheckListings).toHaveLength(2);
    expect(recheckListings.every((path) => !path.includes("status="))).toBe(true);
    expect(recheckListings.filter((path) => path.includes("head_sha="))).toHaveLength(1);
  });

  it("rejects a direct main push without an associated merged PR", async () => {
    const api = resolverApi();
    await expect(
      resolveCandidate({
        api: async (path: string) =>
          path.includes(`/commits/${commit}/pulls`) ? [] : api(path),
        ...options,
      }),
    ).rejects.toThrow("merged pull request");
  });

  it("rejects fork PRs and non-allowlisted mergers", async () => {
    const fork = fixture();
    fork.pullRequest.head.repo.full_name = "attacker/brain";
    await expect(
      resolveCandidate({ api: resolverApi(fork), ...options }),
    ).rejects.toThrow("merged pull request");

    const wrongMerger = fixture();
    wrongMerger.pullRequest.merged_by.login = "mallory";
    await expect(
      resolveCandidate({ api: resolverApi(wrongMerger), ...options }),
    ).rejects.toThrow("stable account");
  });

  it("rejects duplicate, expired, or run-detached artifacts", async () => {
    const duplicate = fixture();
    const api = resolverApi(duplicate);
    await expect(
      resolveCandidate({
        api: async (path: string) =>
          path.includes(`/actions/runs/${duplicate.run.id}/artifacts`)
            ? {
                total_count: 2,
                artifacts: [duplicate.artifact, { ...duplicate.artifact, id: 502 }],
              }
            : api(path),
        ...options,
      }),
    ).rejects.toThrow("exactly one named artifact");

    const expired = fixture();
    expired.artifact.expired = true;
    await expect(
      resolveCandidate({ api: resolverApi(expired), ...options }),
    ).rejects.toThrow("pinned Linux x64 contract");

    const detached = fixture();
    detached.artifact.workflow_run.id = 999;
    await expect(
      resolveCandidate({ api: resolverApi(detached), ...options }),
    ).rejects.toThrow("different workflow run or repository");
  });

  it("rejects a stale main ref or changed run attempt on recheck", async () => {
    const candidate = await resolveCandidate({ api: resolverApi(), ...options });
    const advanced = fixture();
    advanced.ref.object.sha = "c".repeat(40);
    await expect(
      recheckCandidate({ api: recheckApi(advanced), candidate, ...options }),
    ).rejects.toThrow("main advanced");

    const rerun = fixture();
    rerun.run.run_attempt = 2;
    await expect(
      recheckCandidate({ api: recheckApi(rerun), candidate, ...options }),
    ).rejects.toThrow("reruns are not deployable");
  });

  it("rejects an older success when a newer all-status run exists for the SHA", async () => {
    const values = fixture();
    const newerFailure = {
      ...values.run,
      id: 102,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      created_at: "2026-07-12T10:00:03Z",
      run_started_at: "2026-07-12T10:00:04Z",
    };
    values.overallRuns = [newerFailure, values.run];
    values.commitRuns = [newerFailure, values.run];
    await expect(
      resolveCandidate({ api: resolverApi(values), ...options }),
    ).rejects.toThrow("exactly one all-status CI run");
  });

  it("requires the current-main run to remain newest on every recheck", async () => {
    const candidate = await resolveCandidate({ api: resolverApi(), ...options });
    const values = fixture();
    const delayedFailure = {
      ...values.run,
      id: 102,
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
      created_at: "2026-07-12T10:00:03Z",
      run_started_at: "2026-07-12T10:00:04Z",
    };
    values.overallRuns = [delayedFailure, values.run];
    values.commitRuns = [delayedFailure, values.run];
    await expect(
      recheckCandidate({ api: recheckApi(values), candidate, ...options }),
    ).rejects.toThrow("exactly one all-status CI run");
  });

  it("rejects a valid SHA run that is not the newest workflow run overall", async () => {
    const values = fixture();
    values.overallRuns = [
      {
        ...values.run,
        id: 102,
        head_sha: "c".repeat(40),
        head_commit: { id: "c".repeat(40) },
        created_at: "2026-07-12T10:00:03Z",
        run_started_at: "2026-07-12T10:00:04Z",
      },
      values.run,
    ];
    await expect(
      resolveCandidate({ api: resolverApi(values), ...options }),
    ).rejects.toThrow("successful main-push contract");
  });

  it("rejects disagreeing identities from the two workflow listings", async () => {
    const values = fixture();
    values.overallRuns = [
      {
        ...values.run,
        triggering_actor: { login: "mallory", id: 99 },
      },
    ];
    await expect(
      resolveCandidate({ api: resolverApi(values), ...options }),
    ).rejects.toThrow("listings disagree");
  });

  it("rejects a CI run that predates the claimed merge", async () => {
    const values = fixture();
    values.run.created_at = "2026-07-12T09:59:59Z";
    await expect(
      resolveCandidate({ api: resolverApi(values), ...options }),
    ).rejects.toThrow("predates the pull request merge");
  });

  it("rejects reruns, delayed first attempts, and actors outside the stable identity", async () => {
    const replay = fixture();
    replay.run.run_attempt = 2;
    replay.run.run_started_at = "2026-07-30T10:00:00Z";
    replay.run.triggering_actor = { login: "mallory", id: 99 };
    replay.artifact.created_at = "2026-07-30T10:00:03Z";
    replay.artifact.expires_at = "2026-08-13T10:00:03Z";
    await expect(
      resolveCandidate({ api: resolverApi(replay), ...options }),
    ).rejects.toThrow("reruns are not deployable");

    const delayed = fixture();
    delayed.run.run_started_at = "2026-07-12T10:06:01Z";
    delayed.artifact.created_at = "2026-07-12T10:06:02Z";
    await expect(
      resolveCandidate({ api: resolverApi(delayed), ...options }),
    ).rejects.toThrow("attempt started too long after");

    const lateCreated = fixture();
    lateCreated.run.created_at = "2026-07-12T10:06:00Z";
    lateCreated.run.run_started_at = "2026-07-12T10:06:01Z";
    lateCreated.artifact.created_at = "2026-07-12T10:06:02Z";
    await expect(
      resolveCandidate({ api: resolverApi(lateCreated), ...options }),
    ).rejects.toThrow("created too long after");

    const otherTrigger = fixture();
    otherTrigger.run.triggering_actor = { login: "mallory", id: 99 };
    await expect(
      resolveCandidate({ api: resolverApi(otherTrigger), ...options }),
    ).rejects.toThrow("stable account");

    const otherActor = fixture();
    otherActor.run.actor.id = 99;
    await expect(
      resolveCandidate({ api: resolverApi(otherActor), ...options }),
    ).rejects.toThrow("stable account");
  });

  it("does not authorize a reclaimed allowlisted login with another account id", async () => {
    const reclaimed = fixture();
    reclaimed.pullRequest.merged_by.id = 99;
    reclaimed.run.actor.id = 99;
    reclaimed.run.triggering_actor.id = 99;
    await expect(
      resolveCandidate({ api: resolverApi(reclaimed), ...options }),
    ).rejects.toThrow("stable account");
  });

  it("fails closed when the exact artifact listing is paginated", async () => {
    const values = fixture();
    const api = resolverApi(values);
    await expect(
      resolveCandidate({
        api: async (path: string) =>
          path.includes(`/actions/runs/${values.run.id}/artifacts`)
            ? {
                total_count: 101,
                artifacts: Array.from({ length: 100 }, (_, index) => ({
                  ...values.artifact,
                  id: values.artifact.id + index,
                })),
              }
            : api(path),
        ...options,
      }),
    ).rejects.toThrow("exactly one named artifact");
  });

  it("checks every bounded associated-PR page before exactly-one selection", async () => {
    const values = fixture();
    const api = resolverApi(values);
    const ineligible = Array.from({ length: 99 }, (_, index) => ({
      ...values.pullRequest,
      number: 100 + index,
      state: "open",
      merged_at: null,
    }));
    const secondEligible = { ...values.pullRequest, number: 8 };
    await expect(
      resolveCandidate({
        api: async (path: string) => {
          if (path.includes(`/commits/${commit}/pulls`)) {
            return path.includes("page=2")
              ? [secondEligible]
              : [values.pullRequest, ...ineligible];
          }
          return api(path);
        },
        ...options,
      }),
    ).rejects.toThrow("exactly one merged pull request");
  });

  it("rechecks every associated-PR page and rejects a late second attribution", async () => {
    const candidate = await resolveCandidate({
      api: resolverApi(),
      ...options,
    });
    const values = fixture();
    const api = recheckApi(values);
    const ineligible = Array.from({ length: 99 }, (_, index) => ({
      ...values.pullRequest,
      number: 100 + index,
      state: "open",
      merged_at: null,
    }));
    const secondEligible = { ...values.pullRequest, number: 8 };
    const associatedPages: string[] = [];
    await expect(
      recheckCandidate({
        api: async (path: string) => {
          if (path.includes(`/commits/${commit}/pulls`)) {
            associatedPages.push(path);
            return path.includes("page=2")
              ? [secondEligible]
              : [values.pullRequest, ...ineligible];
          }
          return api(path);
        },
        candidate,
        ...options,
      }),
    ).rejects.toThrow("exactly one merged pull request");
    expect(associatedPages).toHaveLength(2);
    expect(associatedPages[1]).toContain("page=2");
  });

  it("requires the sole rechecked association to remain the pinned PR", async () => {
    const candidate = await resolveCandidate({
      api: resolverApi(),
      ...options,
    });
    const values = fixture();
    const api = recheckApi(values);
    await expect(
      recheckCandidate({
        api: async (path: string) =>
          path.includes(`/commits/${commit}/pulls`)
            ? [{ ...values.pullRequest, number: 8 }]
            : api(path),
        candidate,
        ...options,
      }),
    ).rejects.toThrow("associated pull request changed");
  });

  it("requires complete artifact workflow-run and repository provenance", async () => {
    const missing = fixture();
    Reflect.deleteProperty(missing.artifact, "workflow_run");
    await expect(
      resolveCandidate({ api: resolverApi(missing), ...options }),
    ).rejects.toThrow("different workflow run or repository");

    const wrongHead = fixture();
    wrongHead.artifact.workflow_run.head_sha = "c".repeat(40);
    await expect(
      resolveCandidate({ api: resolverApi(wrongHead), ...options }),
    ).rejects.toThrow("different workflow run or repository");
  });

  it("rejects force-pushing an old approved SHA behind the active release", async () => {
    const replay = fixture();
    const activeCommit = "c".repeat(40);
    replay.comparison = {
      status: "behind",
      base_commit: { sha: activeCommit },
      merge_base_commit: { sha: commit },
      ahead_by: 0,
      behind_by: 1,
    };
    await expect(
      resolveCandidate({
        api: resolverApi(replay),
        ...options,
        minimumCommit: activeCommit,
      }),
    ).rejects.toThrow("not a forward descendant");
  });

  it("rechecks an active release without consulting an expired artifact", async () => {
    const candidate = await resolveCandidate({ api: resolverApi(), ...options });
    const paths: string[] = [];
    await expect(
      recheckCandidate({
        api: async (path: string) => {
          paths.push(path);
          return recheckApi()(path);
        },
        candidate,
        ...options,
        verifyArtifact: false,
      }),
    ).resolves.toBe(candidate);
    expect(paths.some((path) => path.includes("/actions/artifacts/"))).toBe(false);
  });

  it("rejects an artifact left over from an earlier run attempt", async () => {
    const values = fixture();
    values.artifact.created_at = "2026-07-12T10:00:01Z";
    await expect(
      resolveCandidate({ api: resolverApi(values), ...options }),
    ).rejects.toThrow("predates the pinned workflow run attempt");
  });
});

function releaseFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    tag_name: "v0.9.0",
    name: "v0.9.0",
    draft: false,
    prerelease: false,
    published_at: "2026-07-12T10:00:00Z",
    author: { login: "MichaelBrowk", id: 4_010_101 },
    assets: [
      { id: 11, name: "brain-0.9.0-linux-x64.tar.gz", state: "uploaded", size: 4096 },
      { id: 12, name: "SHA256SUMS", state: "uploaded", size: 99 },
    ],
    ...overrides,
  };
}

function releaseApi(
  values: {
    release?: ReturnType<typeof releaseFixture>;
    latest?: ReturnType<typeof releaseFixture> | null;
    tagType?: "commit" | "tag";
  } = {},
) {
  const release = values.release ?? releaseFixture();
  const latest = values.latest === undefined ? release : values.latest;
  return async (path: string, options?: { allowMissing?: boolean }) => {
    if (path === `/repos/${repository}`) {
      return { id: repositoryId, full_name: repository };
    }
    if (path === `/repos/${repository}/releases/latest`) {
      if (latest === null) {
        if (options?.allowMissing) return null;
        throw new Error("GitHub API returned 404");
      }
      return latest;
    }
    if (path === `/repos/${repository}/releases/tags/${release.tag_name}`) {
      return release;
    }
    if (path === `/repos/${repository}/releases/${release.id}`) return release;
    if (path === `/repos/${repository}/git/ref/tags/${release.tag_name}`) {
      return values.tagType === "tag"
        ? { ref: `refs/tags/${release.tag_name}`, object: { type: "tag", sha: "c".repeat(40) } }
        : { ref: `refs/tags/${release.tag_name}`, object: { type: "commit", sha: commit } };
    }
    if (path === `/repos/${repository}/git/tags/${"c".repeat(40)}`) {
      return { tag: release.tag_name, object: { type: "commit", sha: commit } };
    }
    if (path.includes("/compare/")) {
      return {
        status: "ahead",
        base_commit: { sha: minimumCommit },
        merge_base_commit: { sha: minimumCommit },
        ahead_by: 1,
        behind_by: 0,
      };
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("release provenance", () => {
  it("parses the source and the optional pin", () => {
    expect(parseDeploySource(undefined)).toBe("ci");
    expect(parseDeploySource("release")).toBe("release");
    expect(() => parseDeploySource("github")).toThrow(
      "BRAIN_DEPLOY_SOURCE must be ci or release",
    );
    expect(parseReleaseTag(undefined)).toBeNull();
    expect(parseReleaseTag("v0.9.0-rc.1")).toBe("v0.9.0-rc.1");
    expect(() => parseReleaseTag("0.9.0")).toThrow(
      "BRAIN_DEPLOY_RELEASE_TAG must be a v<semver> tag",
    );
  });

  it("accepts a release the workflow authored as github-actions[bot]", async () => {
    const release = releaseFixture({
      author: { login: "github-actions[bot]", id: 41_898_282 },
    });
    const candidate = await resolveReleaseCandidate({
      api: releaseApi({ release }),
      repository,
      minimumCommit,
      releaseTag: null,
      maxArtifactBytes: 1024 * 1024,
    });
    expect(candidate.release).toMatchObject({
      author: "github-actions[bot]",
      authorId: 41_898_282,
    });
  });

  it("pins the latest published non-pre-release, its tag commit, and both assets", async () => {
    const candidate = await resolveReleaseCandidate({
      api: releaseApi(),
      repository,
      minimumCommit,
      releaseTag: null,
      maxArtifactBytes: 1024 * 1024,
    });
    expect(candidate).toMatchObject({
      schema: 3,
      kind: "release",
      repositoryId,
      commit,
      minimumCommit,
      release: {
        id: 501,
        tagName: "v0.9.0",
        version: "0.9.0",
        prerelease: false,
        pinned: false,
        author: "michaelbrowk",
        authorId: 4_010_101,
      },
      assets: {
        tarball: { id: 11, name: "brain-0.9.0-linux-x64.tar.gz", sizeInBytes: 4096 },
        checksums: { id: 12, name: "SHA256SUMS", sizeInBytes: 99 },
      },
    });
    expect(validateReleaseCandidate(candidate)).toBe(candidate);
    expect(
      await releaseTargetCommit({
        api: releaseApi({ tagType: "tag" }),
        repository,
        releaseTag: null,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).toBe(commit);
  });

  it("waits quietly when nothing is published and refuses drafts, unpinned pre-releases, and missing assets", async () => {
    await expect(
      resolveReleaseCandidate({
        api: releaseApi({ latest: null }),
        repository,
        minimumCommit,
        releaseTag: null,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "candidate_not_ready" });
    await expect(
      resolveReleaseCandidate({
        api: releaseApi({ release: releaseFixture({ draft: true }) }),
        repository,
        minimumCommit,
        releaseTag: null,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("release is a draft");
    await expect(
      resolveReleaseCandidate({
        api: releaseApi({
          release: releaseFixture({
            prerelease: true,
            tag_name: "v0.9.0-rc.1",
            assets: [
              { id: 11, name: "brain-0.9.0-rc.1-linux-x64.tar.gz", state: "uploaded", size: 1 },
              { id: 12, name: "SHA256SUMS", state: "uploaded", size: 1 },
            ],
          }),
        }),
        repository,
        minimumCommit,
        releaseTag: null,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("latest release is a pre-release");
    await expect(
      resolveReleaseCandidate({
        api: releaseApi({ release: releaseFixture({ assets: [] }) }),
        repository,
        minimumCommit,
        releaseTag: null,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("exactly one tarball and one SHA256SUMS");
  });

  it("deploys a pinned pre-release and rejects a pin that names another tag", async () => {
    const rc = releaseFixture({
      id: 777,
      tag_name: "v0.9.0-rc.1",
      prerelease: true,
      assets: [
        { id: 21, name: "brain-0.9.0-rc.1-linux-x64.tar.gz", state: "uploaded", size: 10 },
        { id: 22, name: "SHA256SUMS", state: "uploaded", size: 10 },
      ],
    });
    const candidate = await resolveReleaseCandidate({
      api: releaseApi({ release: rc, latest: null }),
      repository,
      minimumCommit,
      releaseTag: "v0.9.0-rc.1",
      maxArtifactBytes: 1024 * 1024,
    });
    expect(candidate.release).toMatchObject({
      pinned: true,
      prerelease: true,
      version: "0.9.0-rc.1",
    });
    expect(() =>
      validateReleaseCandidate({
        ...candidate,
        release: { ...candidate.release, pinned: false },
      }),
    ).toThrow("an unpinned pre-release is never deployable");
  });

  it("rechecks identity, target, and tag commit before promotion", async () => {
    const candidate = await resolveReleaseCandidate({
      api: releaseApi(),
      repository,
      minimumCommit,
      releaseTag: null,
      maxArtifactBytes: 1024 * 1024,
    });
    await expect(
      recheckReleaseCandidate({ api: releaseApi(), candidate, maxArtifactBytes: 1024 * 1024 }),
    ).resolves.toBe(candidate);
    const newer = releaseFixture({
      id: 502,
      tag_name: "v0.9.1",
      assets: [
        { id: 31, name: "brain-0.9.1-linux-x64.tar.gz", state: "uploaded", size: 1 },
        { id: 32, name: "SHA256SUMS", state: "uploaded", size: 1 },
      ],
    });
    await expect(
      recheckReleaseCandidate({
        api: releaseApi({ latest: newer }),
        candidate,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("another release became the deployment target");
    const movedTag = async (path: string, options?: { allowMissing?: boolean }) =>
      path.endsWith("/git/ref/tags/v0.9.0")
        ? { ref: "refs/tags/v0.9.0", object: { type: "commit", sha: "d".repeat(40) } }
        : releaseApi()(path, options);
    await expect(
      recheckReleaseCandidate({ api: movedTag, candidate, maxArtifactBytes: 1024 * 1024 }),
    ).rejects.toThrow("release tag moved");
  });
});
