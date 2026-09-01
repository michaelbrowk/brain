import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const repositoryId = 1_296_646_939;

function deployCandidate(commit: string) {
  return {
    schema: 2,
    repository: "michaelbrowk/brain",
    repositoryId,
    branch: "main",
    minimumCommit: commit,
    commit,
    pullRequest: {
      number: 7,
      mergedAt: "2026-07-12T10:00:00Z",
      mergedBy: "michaelbrowk",
      mergedById: 42,
      headRepository: "michaelbrowk/brain",
      baseRepositoryId: repositoryId,
      headRepositoryId: repositoryId,
    },
    workflow: {
      file: "ci.yml",
      workflowId: 11,
      runId: 101,
      runAttempt: 1,
      createdAt: "2026-07-12T10:00:01Z",
      startedAt: "2026-07-12T10:00:02Z",
      actor: "michaelbrowk",
      actorId: 42,
      triggeringActor: "michaelbrowk",
      triggeringActorId: 42,
      repositoryId,
      headRepositoryId: repositoryId,
    },
    artifact: {
      id: 501,
      name: `brain-standalone-linux-x64-${commit}`,
      sizeInBytes: 4096,
      digest: `sha256:${"b".repeat(64)}`,
      createdAt: "2026-07-12T10:00:03Z",
      expiresAt: "2026-07-26T10:00:03Z",
      workflowRunId: 101,
      workflowHeadSha: commit,
      workflowHeadBranch: "main",
      repositoryId,
      headRepositoryId: repositoryId,
    },
    resolvedAt: "2026-07-12T10:01:00Z",
  };
}

function releaseCandidate(commit: string) {
  return {
    schema: 3,
    kind: "release",
    repository: "michaelbrowk/brain",
    repositoryId,
    minimumCommit: commit,
    commit,
    release: {
      id: 501,
      tagName: "v0.9.0",
      version: "0.9.0",
      prerelease: false,
      pinned: false,
      publishedAt: "2026-07-12T10:00:00Z",
      author: "michaelbrowk",
      authorId: 42,
    },
    assets: {
      tarball: { id: 11, name: "brain-0.9.0-linux-x64.tar.gz", sizeInBytes: 4096 },
      checksums: { id: 12, name: "SHA256SUMS", sizeInBytes: 99 },
    },
    resolvedAt: "2026-07-12T10:05:00Z",
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("release artifact provenance", () => {
  it("accepts an intact exact-commit artifact and rejects tampering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-artifact-"));
    roots.push(root);
    const archive = path.join(root, "brain-standalone-linux-x64.tar.gz");
    const manifest = path.join(root, "brain-standalone-linux-x64.json");
    const commit = "a".repeat(40);
    const builtAt = "2026-07-11T10:00:00Z";
    await fs.writeFile(archive, "trusted-linux-artifact");

    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/write-artifact-manifest.mjs"),
      archive,
      manifest,
      commit,
      builtAt,
    ]);
    const verified = await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/verify-release-artifact.mjs"),
      archive,
      manifest,
      commit,
    ]);
    expect(verified.stdout).toBe(builtAt);

    await fs.appendFile(archive, "tampered");
    await expect(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), "scripts/verify-release-artifact.mjs"),
        archive,
        manifest,
        commit,
      ]),
    ).rejects.toThrow();
  });

  it("records the exact PR, run attempt, and artifact in release metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-meta-"));
    roots.push(root);
    const destination = path.join(root, "release.json");
    const provenance = path.join(root, "provenance.json");
    const provenanceDestination = path.join(root, "deploy-provenance.json");
    const commit = "a".repeat(40);
    const rawProvenance = `${JSON.stringify(deployCandidate(commit), null, 2)}\n`;
    await fs.writeFile(provenance, rawProvenance);

    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/write-release-metadata.mjs"),
      destination,
      "aaaaaaaaaaaa-20260712T100000Z-deadbeef",
      commit,
      "2026-07-12T10:00:00Z",
      provenance,
      provenanceDestination,
    ]);

    await expect(fs.readFile(destination, "utf8").then(JSON.parse)).resolves.toMatchObject(
      {
        commit,
        source: {
          repository: "michaelbrowk/brain",
          repositoryId,
          minimumCommit: commit,
          pullRequest: 7,
          mergedById: 42,
          runId: 101,
          runAttempt: 1,
          runActorId: 42,
          runTriggeringActorId: 42,
          artifactId: 501,
          artifactWorkflowRunId: 101,
        },
      },
    );
    await expect(fs.readFile(provenanceDestination, "utf8")).resolves.toBe(
      rawProvenance,
    );
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o444);
    expect((await fs.stat(provenanceDestination)).mode & 0o777).toBe(0o444);
  });

  it("loads the validator from the installer's flat bin layout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-flat-bin-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const writer = path.join(bin, "write-release-metadata.mjs");
    const validator = path.join(bin, "deploy-provenance.mjs");
    await Promise.all([
      fs.copyFile(
        path.join(process.cwd(), "scripts/write-release-metadata.mjs"),
        writer,
      ),
      fs.copyFile(
        path.join(process.cwd(), "ops/deploy-provenance.mjs"),
        validator,
      ),
    ]);
    const commit = "a".repeat(40);
    const provenance = path.join(root, "candidate.json");
    const destination = path.join(root, "release.json");
    await fs.writeFile(
      provenance,
      `${JSON.stringify(deployCandidate(commit), null, 2)}\n`,
    );

    await execFileAsync(process.execPath, [
      writer,
      destination,
      "aaaaaaaaaaaa-20260712T100000Z-deadbeef",
      commit,
      "2026-07-12T10:00:00Z",
      provenance,
    ]);

    await expect(fs.readFile(destination, "utf8").then(JSON.parse)).resolves.toMatchObject(
      {
        commit,
        source: { schema: 2, runAttempt: 1, runTriggeringActorId: 42 },
      },
    );
  });

  it("never overwrites reserved metadata names or follows symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-reserved-"));
    roots.push(root);
    const writer = path.join(process.cwd(), "scripts/write-release-metadata.mjs");
    const commit = "a".repeat(40);
    const release = "aaaaaaaaaaaa-20260712T100000Z-deadbeef";
    const builtAt = "2026-07-12T10:00:00Z";
    const victim = path.join(root, "victim.txt");
    const provenance = path.join(root, "candidate.json");
    await fs.writeFile(victim, "do-not-touch");
    await fs.writeFile(
      provenance,
      `${JSON.stringify(deployCandidate(commit), null, 2)}\n`,
    );

    const occupiedRelease = path.join(root, "occupied-release.json");
    await fs.writeFile(occupiedRelease, "reserved");
    await expect(
      execFileAsync(process.execPath, [
        writer,
        occupiedRelease,
        release,
        commit,
        builtAt,
      ]),
    ).rejects.toThrow();
    await expect(fs.readFile(occupiedRelease, "utf8")).resolves.toBe("reserved");

    const releaseSymlink = path.join(root, "release-symlink.json");
    await fs.symlink(victim, releaseSymlink);
    await expect(
      execFileAsync(process.execPath, [
        writer,
        releaseSymlink,
        release,
        commit,
        builtAt,
      ]),
    ).rejects.toThrow();
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("do-not-touch");

    const provenanceSymlink = path.join(root, "provenance-symlink.json");
    const absentRelease = path.join(root, "absent-release.json");
    await fs.symlink(victim, provenanceSymlink);
    await expect(
      execFileAsync(process.execPath, [
        writer,
        absentRelease,
        release,
        commit,
        builtAt,
        provenance,
        provenanceSymlink,
      ]),
    ).rejects.toThrow();
    await expect(fs.stat(absentRelease)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("do-not-touch");

    const sourceSymlink = path.join(root, "candidate-symlink.json");
    await fs.symlink(provenance, sourceSymlink);
    await expect(
      execFileAsync(process.execPath, [
        writer,
        absentRelease,
        release,
        commit,
        builtAt,
        sourceSymlink,
      ]),
    ).rejects.toThrow();
    await expect(fs.stat(absentRelease)).rejects.toMatchObject({ code: "ENOENT" });

    const partialRelease = path.join(root, "partial-release.json");
    const copiedProvenance = path.join(root, "copied-provenance.json");
    await fs.writeFile(partialRelease, "reserved");
    await expect(
      execFileAsync(process.execPath, [
        writer,
        partialRelease,
        release,
        commit,
        builtAt,
        provenance,
        copiedProvenance,
      ]),
    ).rejects.toThrow();
    await expect(fs.stat(copiedProvenance)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(partialRelease, "utf8")).resolves.toBe("reserved");
  });

  it("merges the shipped release.json with release provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-merge-"));
    roots.push(root);
    const commit = "a".repeat(40);
    const shipped = path.join(root, "shipped-release.json");
    const provenance = path.join(root, "candidate.json");
    const destination = path.join(root, "release.json");
    await fs.writeFile(
      shipped,
      `${JSON.stringify({
        schema: 1,
        version: "0.9.0",
        commit,
        buildTime: "2026-07-12T10:00:00Z",
        minUpgradeFrom: "0.9.0",
      })}\n`,
    );
    await fs.writeFile(provenance, `${JSON.stringify(releaseCandidate(commit))}\n`);
    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/write-release-metadata.mjs"),
      destination,
      "aaaaaaaaaaaa-20260712T100000Z-deadbeef",
      commit,
      "2026-07-12T10:00:00Z",
      provenance,
      path.join(root, "deploy-provenance.json"),
      shipped,
    ]);
    await expect(fs.readFile(destination, "utf8").then(JSON.parse)).resolves.toEqual({
      schema: 1,
      version: "0.9.0",
      commit,
      buildTime: "2026-07-12T10:00:00Z",
      minUpgradeFrom: "0.9.0",
      release: "aaaaaaaaaaaa-20260712T100000Z-deadbeef",
      builtAt: "2026-07-12T10:00:00Z",
      source: {
        schema: 3,
        kind: "release",
        repository: "michaelbrowk/brain",
        repositoryId,
        minimumCommit: commit,
        releaseId: 501,
        tagName: "v0.9.0",
        version: "0.9.0",
        prerelease: false,
        pinned: false,
        publishedAt: "2026-07-12T10:00:00Z",
        author: "michaelbrowk",
        authorId: 42,
        tarballAssetId: 11,
        tarballName: "brain-0.9.0-linux-x64.tar.gz",
        tarballSizeInBytes: 4096,
        checksumsAssetId: 12,
        checksumsSizeInBytes: 99,
        resolvedAt: "2026-07-12T10:05:00Z",
      },
    });
  });

  it("refuses shipped metadata that names another commit or build time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-merge-bad-"));
    roots.push(root);
    const commit = "a".repeat(40);
    const shipped = path.join(root, "shipped-release.json");
    await fs.writeFile(
      shipped,
      `${JSON.stringify({
        schema: 1,
        version: "0.9.0",
        commit: "b".repeat(40),
        buildTime: "2026-07-12T10:00:00Z",
        minUpgradeFrom: "0.9.0",
      })}\n`,
    );
    await expect(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), "scripts/write-release-metadata.mjs"),
        path.join(root, "release.json"),
        "aaaaaaaaaaaa-20260712T100000Z-deadbeef",
        commit,
        "2026-07-12T10:00:00Z",
        "",
        "",
        shipped,
      ]),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(root, "release.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("verifies a file against its SHA256SUMS line and rejects a mismatch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-checksums-"));
    roots.push(root);
    const file = path.join(root, "brain-0.9.0-linux-x64.tar.gz");
    await fs.writeFile(file, "tarball");
    const digest = createHash("sha256").update("tarball").digest("hex");
    const sums = path.join(root, "SHA256SUMS");
    await fs.writeFile(sums, `${digest}  brain-0.9.0-linux-x64.tar.gz\n`);
    const verified = await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/verify-checksums.mjs"),
      sums,
      file,
    ]);
    expect(verified.stdout).toBe(`${digest}\n`);
    await fs.appendFile(file, "x");
    await expect(
      execFileAsync(process.execPath, [
        path.join(process.cwd(), "scripts/verify-checksums.mjs"),
        sums,
        file,
      ]),
    ).rejects.toThrow();
  });

  it("writes the pre-branch shape byte-for-byte when args 5, 6, and 7 are empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-plain-"));
    roots.push(root);
    const destination = path.join(root, "release.json");
    const commit = "a".repeat(40);
    const release = "aaaaaaaaaaaa-20260712T100000Z-deadbeef";
    const builtAt = "2026-07-12T10:00:00Z";
    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts/write-release-metadata.mjs"),
      destination,
      release,
      commit,
      builtAt,
      "",
      "",
      "",
    ]);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe(
      `${JSON.stringify({ release, commit, builtAt }, null, 2)}\n`,
    );
  });
});
