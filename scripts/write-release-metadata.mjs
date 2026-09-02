import { constants } from "node:fs";
import { lstat, open, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!Number.isInteger(constants.O_NOFOLLOW)) {
  throw new Error("this platform cannot enforce no-follow metadata access");
}

const [
  destination,
  release,
  commit,
  builtAt,
  provenancePath,
  provenanceDestination,
  shippedMetadataPath,
] = process.argv.slice(2);

if (
  !destination ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release ?? "") ||
  !/^[0-9a-f]{40}$/.test(commit ?? "") ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(builtAt ?? "") ||
  !Number.isFinite(Date.parse(builtAt)) ||
  (provenanceDestination && !provenancePath) ||
  (provenanceDestination &&
    resolve(provenanceDestination) === resolve(destination)) ||
  (shippedMetadataPath && resolve(shippedMetadataPath) === resolve(destination))
) {
  throw new Error(
    "usage: write-release-metadata.mjs <release.json> <release> <commit> " +
      "<builtAt> [candidate.json] [deploy-provenance.json] " +
      "[shipped-release.json]",
  );
}

async function regularModule(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile()) {
    throw new Error(`deploy provenance validator is not a regular file: ${path}`);
  }
  return true;
}

async function loadCandidateValidator() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(directory, "deploy-provenance.mjs"),
    join(directory, "..", "ops", "deploy-provenance.mjs"),
  ];
  const available = [];
  for (const candidate of candidates) {
    if (await regularModule(candidate)) available.push(candidate);
  }
  if (available.length !== 1) {
    throw new Error(
      "expected exactly one deploy provenance validator in the installed or repository layout",
    );
  }
  const loaded = await import(pathToFileURL(available[0]).href);
  if (typeof loaded.validateCandidate !== "function") {
    throw new Error("deploy provenance validator export is missing");
  }
  return loaded.validateCandidate;
}

const validateCandidate = await loadCandidateValidator();

async function readRegularNoFollow(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 1024 * 1024) {
      throw new Error("deploy provenance source must be a bounded regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function exclusiveDurableWrite(path, contents) {
  // The puller normalizes the release tree to root:brain before this file is
  // created, and Linux gives a new file the writer's primary group, not the
  // directory's. Take the directory's group (setgid semantics) so the service
  // user can read the file like the rest of the tree.
  const { gid } = await stat(dirname(path));
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o400,
  );
  let failure;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.chown((await handle.stat()).uid, gid);
    await handle.chmod(0o444);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    await unlink(path).catch(() => undefined);
    throw failure;
  }
}

let provenanceRaw;
let source;
if (provenancePath) {
  provenanceRaw = await readRegularNoFollow(provenancePath);
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(provenanceRaw),
    );
  } catch {
    throw new Error("deploy provenance is not valid UTF-8 JSON");
  }
  const provenance = validateCandidate(parsed);
  if (provenance.commit !== commit) {
    throw new Error("deploy provenance belongs to another commit");
  }
  if (provenance.schema === 3) {
    source = {
      schema: provenance.schema,
      kind: "release",
      repository: provenance.repository,
      repositoryId: provenance.repositoryId,
      minimumCommit: provenance.minimumCommit,
      releaseId: provenance.release.id,
      tagName: provenance.release.tagName,
      version: provenance.release.version,
      prerelease: provenance.release.prerelease,
      pinned: provenance.release.pinned,
      publishedAt: provenance.release.publishedAt,
      author: provenance.release.author,
      authorId: provenance.release.authorId,
      tarballAssetId: provenance.assets.tarball.id,
      tarballName: provenance.assets.tarball.name,
      tarballSizeInBytes: provenance.assets.tarball.sizeInBytes,
      checksumsAssetId: provenance.assets.checksums.id,
      checksumsSizeInBytes: provenance.assets.checksums.sizeInBytes,
      resolvedAt: provenance.resolvedAt,
    };
  } else {
    source = {
      schema: provenance.schema,
      repository: provenance.repository,
      repositoryId: provenance.repositoryId,
      branch: provenance.branch,
      minimumCommit: provenance.minimumCommit,
      pullRequest: provenance.pullRequest.number,
      mergedAt: provenance.pullRequest.mergedAt,
      mergedBy: provenance.pullRequest.mergedBy,
      mergedById: provenance.pullRequest.mergedById,
      pullBaseRepositoryId: provenance.pullRequest.baseRepositoryId,
      pullHeadRepositoryId: provenance.pullRequest.headRepositoryId,
      workflowFile: provenance.workflow.file,
      workflowId: provenance.workflow.workflowId,
      runId: provenance.workflow.runId,
      runAttempt: provenance.workflow.runAttempt,
      runCreatedAt: provenance.workflow.createdAt,
      runStartedAt: provenance.workflow.startedAt,
      runActor: provenance.workflow.actor,
      runActorId: provenance.workflow.actorId,
      runTriggeringActor: provenance.workflow.triggeringActor,
      runTriggeringActorId: provenance.workflow.triggeringActorId,
      runRepositoryId: provenance.workflow.repositoryId,
      runHeadRepositoryId: provenance.workflow.headRepositoryId,
      artifactId: provenance.artifact.id,
      artifactName: provenance.artifact.name,
      artifactSizeInBytes: provenance.artifact.sizeInBytes,
      artifactDigest: provenance.artifact.digest,
      artifactCreatedAt: provenance.artifact.createdAt,
      artifactExpiresAt: provenance.artifact.expiresAt,
      artifactWorkflowRunId: provenance.artifact.workflowRunId,
      artifactWorkflowHeadSha: provenance.artifact.workflowHeadSha,
      artifactWorkflowHeadBranch: provenance.artifact.workflowHeadBranch,
      artifactRepositoryId: provenance.artifact.repositoryId,
      artifactHeadRepositoryId: provenance.artifact.headRepositoryId,
      resolvedAt: provenance.resolvedAt,
    };
  }
}

let shipped = null;
if (shippedMetadataPath) {
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readRegularNoFollow(shippedMetadataPath),
      ),
    );
  } catch {
    throw new Error("shipped release metadata is not valid UTF-8 JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema !== 1 ||
    Object.keys(parsed).sort().join(",") !==
      "buildTime,commit,minUpgradeFrom,schema,version" ||
    parsed.commit !== commit ||
    parsed.buildTime !== builtAt ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      parsed.version,
    ) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      parsed.minUpgradeFrom,
    )
  ) {
    throw new Error("shipped release metadata does not describe this release");
  }
  if (source && source.kind === "release" && source.version !== parsed.version) {
    throw new Error(
      "shipped release metadata version differs from the release provenance",
    );
  }
  shipped = parsed;
}

let wroteProvenance = false;
try {
  if (provenanceDestination) {
    await exclusiveDurableWrite(provenanceDestination, provenanceRaw);
    wroteProvenance = true;
  }

  await exclusiveDurableWrite(
    destination,
    `${JSON.stringify(
      {
        ...(shipped ?? {}),
        release,
        commit,
        builtAt,
        ...(source ? { source } : {}),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (wroteProvenance) {
    await unlink(provenanceDestination).catch(() => undefined);
  }
  throw error;
}
