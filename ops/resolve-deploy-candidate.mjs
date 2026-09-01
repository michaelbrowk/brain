#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import {
  candidateKind,
  currentMainCommit,
  parseAllowedMergers,
  parseDeploySource,
  parseReleaseTag,
  parseRepository,
  parseWorkflow,
  recheckCandidate,
  recheckReleaseCandidate,
  releaseTargetCommit,
  resolveCandidate,
  resolveReleaseCandidate,
  validateCandidate,
} from "./deploy-provenance.mjs";

const API_ROOT = "https://api.github.com";
const DEFAULT_MAX_ZIP_BYTES = 512 * 1024 * 1024;
export const RESOLVER_NETWORK_DEADLINE_MS = 14 * 60 * 1_000;
export const ARTIFACT_STORAGE_TIMEOUT_MS = 10 * 60 * 1_000;
const GITHUB_REQUEST_ATTEMPTS = 4;
const GITHUB_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];
const GITHUB_RETRY_SLEEP_BUDGET_MS = 30_000;
const GITHUB_API_TIMEOUT_MS = 20_000;
const RETRYABLE_GITHUB_STATUSES = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
]);
const CONFIGURATION_KEYS = new Set([
  "BRAIN_DEPLOY_GITHUB_TOKEN",
  "BRAIN_DEPLOY_REPOSITORY",
  "BRAIN_DEPLOY_WORKFLOW",
  "BRAIN_DEPLOY_ALLOWED_MERGERS",
  "BRAIN_DEPLOY_MAX_ZIP_BYTES",
  "BRAIN_DEPLOY_SOURCE",
  "BRAIN_DEPLOY_RELEASE_TAG",
]);

function requiredEnvironment(source, name) {
  const value = source[name];
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} is required and must be one line`);
  }
  return value;
}

function maxZipBytes(source) {
  const raw = source.BRAIN_DEPLOY_MAX_ZIP_BYTES;
  if (raw === undefined) return DEFAULT_MAX_ZIP_BYTES;
  if (!/^[1-9][0-9]{0,11}$/.test(raw)) {
    throw new Error("BRAIN_DEPLOY_MAX_ZIP_BYTES must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 2 * 1024 * 1024 * 1024) {
    throw new Error("BRAIN_DEPLOY_MAX_ZIP_BYTES is outside the safe range");
  }
  return value;
}

export function parseDeployerEnvironment(source) {
  if (typeof source !== "string" || source.includes("\0")) {
    throw new Error("deployer credential is malformed");
  }
  const values = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !CONFIGURATION_KEYS.has(match[1])) {
      throw new Error(`deployer credential line ${index + 1} is not allowed`);
    }
    if (Object.hasOwn(values, match[1])) {
      throw new Error(`deployer credential repeats ${match[1]}`);
    }
    if (!match[2] || /[\r\n\0]/.test(match[2])) {
      throw new Error(`deployer credential ${match[1]} is empty or malformed`);
    }
    values[match[1]] = match[2];
  }
  return values;
}

async function configurationSource() {
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (credentialsDirectory) {
    if (!credentialsDirectory.startsWith("/") || /[\r\n\0]/.test(credentialsDirectory)) {
      throw new Error("CREDENTIALS_DIRECTORY is malformed");
    }
    return parseDeployerEnvironment(
      await readFile(`${credentialsDirectory}/deployer-env`, "utf8"),
    );
  }
  return process.env;
}

export async function configuration() {
  const source = await configurationSource();
  const token = requiredEnvironment(source, "BRAIN_DEPLOY_GITHUB_TOKEN");
  if (token.length < 20 || /\s/.test(token)) {
    throw new Error("BRAIN_DEPLOY_GITHUB_TOKEN is malformed");
  }
  const deploySource = parseDeploySource(source.BRAIN_DEPLOY_SOURCE);
  return {
    token,
    repository: parseRepository(
      requiredEnvironment(source, "BRAIN_DEPLOY_REPOSITORY"),
    ),
    workflow: parseWorkflow(source.BRAIN_DEPLOY_WORKFLOW ?? "ci.yml"),
    // The merger allowlist gates only the ci source. A published release is
    // its own approval, so the key may stay set here and is ignored.
    allowedMergers:
      deploySource === "ci"
        ? parseAllowedMergers(
            requiredEnvironment(source, "BRAIN_DEPLOY_ALLOWED_MERGERS"),
          )
        : null,
    maxArtifactBytes: maxZipBytes(source),
    source: deploySource,
    releaseTag: parseReleaseTag(source.BRAIN_DEPLOY_RELEASE_TAG),
  };
}

function requestHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "brain-deploy-puller/1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubRequestId(response) {
  const requestId = response.headers.get("x-github-request-id");
  return requestId && /^[A-Za-z0-9:-]{1,128}$/.test(requestId)
    ? requestId
    : "unknown";
}

function retryAfterMilliseconds(value, now) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000) {
      return null;
    }
    return seconds * 1_000;
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      trimmed,
    )
  ) {
    return null;
  }
  const retryAt = Date.parse(trimmed);
  if (
    !Number.isFinite(retryAt) ||
    new Date(retryAt).toUTCString() !== trimmed ||
    retryAt <= now
  ) {
    return null;
  }
  return retryAt - now;
}

function isRetryableTransportError(error) {
  return (
    error instanceof TypeError ||
    (typeof error === "object" && error !== null && error.name === "TimeoutError")
  );
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status and request id remain the useful failure signal.
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monotonicNow() {
  return performance.now();
}

function createRequestContext(retry = {}) {
  const now = retry.now ?? monotonicNow;
  return {
    now,
    wallNow: retry.wallNow ?? Date.now,
    sleep: retry.sleep ?? defaultSleep,
    deadlineAt: retry.deadlineAt ?? now() + RESOLVER_NETWORK_DEADLINE_MS,
  };
}

function boundedRequestTimeout(requestContext, maximumMilliseconds, errorMessage) {
  const remaining = requestContext.deadlineAt - requestContext.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error(errorMessage);
  }
  return Math.max(1, Math.min(maximumMilliseconds, Math.floor(remaining)));
}

async function githubExactGet({
  url,
  headers,
  redirect,
  timeoutMs,
  accepts,
  statusError,
  transportError,
  requestContext,
}) {
  const { sleep, now } = requestContext;
  let sleptMilliseconds = 0;

  try {
    new Request(url, { method: "GET", headers, redirect });
  } catch {
    throw new Error(transportError);
  }

  for (let attempt = 0; attempt < GITHUB_REQUEST_ATTEMPTS; attempt += 1) {
    let response;
    try {
      const requestTimeout = boundedRequestTimeout(
        requestContext,
        timeoutMs,
        transportError,
      );
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect,
        signal: AbortSignal.timeout(requestTimeout),
      });
    } catch (error) {
      if (
        !isRetryableTransportError(error) ||
        attempt === GITHUB_REQUEST_ATTEMPTS - 1
      ) {
        throw new Error(transportError);
      }
      const delay = GITHUB_RETRY_BACKOFF_MS[attempt];
      if (
        delay > GITHUB_RETRY_SLEEP_BUDGET_MS - sleptMilliseconds ||
        delay > requestContext.deadlineAt - now()
      ) {
        throw new Error(transportError);
      }
      await sleep(delay);
      sleptMilliseconds += delay;
      continue;
    }

    if (accepts(response)) return response;

    const failure = new Error(statusError(response));
    const retryAfter = retryAfterMilliseconds(
      response.headers.get("retry-after"),
      requestContext.wallNow(),
    );
    const retryable =
      RETRYABLE_GITHUB_STATUSES.has(response.status) ||
      (response.status === 403 && retryAfter !== null);
    await cancelResponseBody(response);
    if (!retryable || attempt === GITHUB_REQUEST_ATTEMPTS - 1) {
      throw failure;
    }

    const delay = retryAfter ?? GITHUB_RETRY_BACKOFF_MS[attempt];
    if (
      delay > GITHUB_RETRY_SLEEP_BUDGET_MS - sleptMilliseconds ||
      delay > requestContext.deadlineAt - now()
    ) {
      throw failure;
    }
    await sleep(delay);
    sleptMilliseconds += delay;
  }

  throw new Error(transportError);
}

export function apiClient(token, retry) {
  const requestContext = createRequestContext(retry);
  return async (apiPath, { allowMissing = false } = {}) => {
    if (typeof apiPath !== "string" || !apiPath.startsWith("/repos/")) {
      throw new Error("refusing a non-repository GitHub API path");
    }
    const response = await githubExactGet({
      url: `${API_ROOT}${apiPath}`,
      headers: requestHeaders(token),
      redirect: "manual",
      timeoutMs: GITHUB_API_TIMEOUT_MS,
      accepts: (candidate) =>
        candidate.ok || (allowMissing && candidate.status === 404),
      statusError: (candidate) => {
        return (
          `GitHub API returned ${candidate.status} ` +
          `(request ${githubRequestId(candidate)})`
        );
      },
      transportError: "GitHub API request failed",
      requestContext,
    });
    if (response.status === 404) {
      await cancelResponseBody(response);
      return null;
    }
    try {
      return await response.json();
    } catch {
      throw new Error("GitHub API returned malformed JSON");
    }
  };
}

export function allowedDownloadHost(hostname) {
  return (
    hostname === "objects.githubusercontent.com" ||
    hostname.endsWith(".actions.githubusercontent.com") ||
    hostname.endsWith(".blob.core.windows.net") ||
    hostname.endsWith(".githubusercontent.com")
  );
}

async function assertMissing(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${path.basename(target)} already exists`);
}

async function downloadRedirectedObject({
  token,
  endpoint,
  accept,
  expectedBytes,
  expectedSha256,
  destination,
  maxBytes,
  retry = {},
}) {
  const requestContext = createRequestContext(retry);
  await assertMissing(destination);
  const redirect = await githubExactGet({
    url: endpoint,
    headers: { ...requestHeaders(token), Accept: accept },
    redirect: "manual",
    timeoutMs: 20_000,
    accepts: (response) => [301, 302, 303, 307, 308].includes(response.status),
    statusError: (response) => {
      return (
        `artifact download did not return a redirect ` +
        `(${response.status}, request ${githubRequestId(response)})`
      );
    },
    transportError: "artifact download request failed",
    requestContext,
  });
  await cancelResponseBody(redirect);
  const location = redirect.headers.get("location");
  if (!location) throw new Error("artifact download redirect is missing");
  const signedUrl = new URL(location);
  if (signedUrl.protocol !== "https:" || !allowedDownloadHost(signedUrl.hostname)) {
    throw new Error("artifact download redirected to an untrusted host");
  }

  let response;
  try {
    const storageTimeout = boundedRequestTimeout(
      requestContext,
      ARTIFACT_STORAGE_TIMEOUT_MS,
      "artifact storage request failed",
    );
    new Request(signedUrl, { method: "GET", redirect: "error" });
    response = await fetch(signedUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(storageTimeout),
    });
  } catch {
    throw new Error("artifact storage request failed");
  }
  if (!response.ok || !response.body) {
    await cancelResponseBody(response);
    throw new Error(`artifact storage returned ${response.status}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const declaredBytes = /^[0-9]+$/.test(declaredLength)
      ? Number(declaredLength)
      : Number.NaN;
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > maxBytes ||
      declaredBytes !== expectedBytes
    ) {
      await cancelResponseBody(response);
      throw new Error("artifact archive length differs from pinned metadata");
    }
  }

  const temporary = `${destination}.part-${process.pid}`;
  await assertMissing(temporary);
  const hash = createHash("sha256");
  let bytes = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new Error("artifact archive exceeded the configured download limit");
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(
      response.body.pipeThrough(limiter),
      createWriteStream(temporary, { flags: "wx", mode: 0o400 }),
    );
    if (bytes !== expectedBytes) {
      throw new Error("downloaded artifact size does not match GitHub metadata");
    }
    if (expectedSha256 !== null) {
      const actualDigest = Buffer.from(hash.digest("hex"), "ascii");
      const expectedDigest = Buffer.from(expectedSha256, "ascii");
      if (
        actualDigest.length !== expectedDigest.length ||
        !timingSafeEqual(actualDigest, expectedDigest)
      ) {
        throw new Error(
          "downloaded artifact digest does not match GitHub metadata",
        );
      }
    }
    await rename(temporary, destination);
    await chmod(destination, 0o400);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function downloadArtifact({
  token,
  candidate,
  destination,
  maxBytes,
  retry = {},
}) {
  validateCandidate(candidate);
  if (candidate.artifact.sizeInBytes > maxBytes) {
    throw new Error("candidate artifact exceeds the configured download limit");
  }
  return downloadRedirectedObject({
    token,
    endpoint:
      `${API_ROOT}/repos/${candidate.repository}/actions/artifacts/` +
      `${candidate.artifact.id}/zip`,
    accept: "application/vnd.github+json",
    expectedBytes: candidate.artifact.sizeInBytes,
    expectedSha256: candidate.artifact.digest.slice(7),
    destination,
    maxBytes,
    retry,
  });
}

export function parseChecksums(text, name) {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const matches = lines.map((line) => /^([0-9a-f]{64})  (\S+)$/.exec(line));
  if (matches.some((match) => match === null)) {
    throw new Error("SHA256SUMS contains a malformed line");
  }
  const entries = matches.filter((match) => match[2] === name);
  if (entries.length !== 1) {
    throw new Error(`SHA256SUMS must name ${name} exactly once`);
  }
  return entries[0][1];
}

export async function downloadReleaseAssets({
  token,
  candidate,
  destination,
  maxBytes,
  retry = {},
}) {
  validateCandidate(candidate);
  if (candidateKind(candidate) !== "release") {
    throw new Error("candidate is not a release");
  }
  if (candidate.assets.tarball.sizeInBytes > maxBytes) {
    throw new Error("candidate tarball exceeds the configured download limit");
  }
  const checksumsPath = path.join(path.dirname(destination), "SHA256SUMS");
  const endpoint = (id) =>
    `${API_ROOT}/repos/${candidate.repository}/releases/assets/${id}`;
  await downloadRedirectedObject({
    token,
    endpoint: endpoint(candidate.assets.checksums.id),
    accept: "application/octet-stream",
    expectedBytes: candidate.assets.checksums.sizeInBytes,
    expectedSha256: null,
    destination: checksumsPath,
    maxBytes: 64 * 1024,
    retry,
  });
  const expectedSha256 = parseChecksums(
    await readFile(checksumsPath, "utf8"),
    candidate.assets.tarball.name,
  );
  await downloadRedirectedObject({
    token,
    endpoint: endpoint(candidate.assets.tarball.id),
    accept: "application/octet-stream",
    expectedBytes: candidate.assets.tarball.sizeInBytes,
    expectedSha256,
    destination,
    maxBytes,
    retry,
  });
  await writeFile(`${destination}.sha256`, `${expectedSha256}\n`, {
    encoding: "utf8",
    mode: 0o400,
    flag: "wx",
  });
  return expectedSha256;
}

async function readCandidate(candidatePath, config) {
  const candidate = validateCandidate(
    JSON.parse(await readFile(candidatePath, "utf8")),
  );
  if (
    candidate.repository !== config.repository ||
    (candidateKind(candidate) === "ci" &&
      candidate.workflow.file !== config.workflow)
  ) {
    throw new Error("candidate does not match the root-managed configuration");
  }
  return candidate;
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  const config = await configuration();
  const requestContext = createRequestContext();
  const api = apiClient(config.token, requestContext);
  const recheckAny = ({ candidate, verifyArtifact = true }) =>
    candidateKind(candidate) === "release"
      ? recheckReleaseCandidate({
          api,
          candidate,
          maxArtifactBytes: config.maxArtifactBytes,
        })
      : recheckCandidate({ api, candidate, ...config, verifyArtifact });

  if (command === "current-main" && !first) {
    process.stdout.write(
      `${await currentMainCommit({ api, repository: config.repository })}\n`,
    );
    return;
  }

  if (command === "target" && !first) {
    const commit =
      config.source === "release"
        ? await releaseTargetCommit({
            api,
            repository: config.repository,
            releaseTag: config.releaseTag,
            maxArtifactBytes: config.maxArtifactBytes,
          })
        : await currentMainCommit({ api, repository: config.repository });
    process.stdout.write(`${commit}\n`);
    return;
  }

  if (command === "resolve" && first && second) {
    await assertMissing(first);
    const candidate =
      config.source === "release"
        ? await resolveReleaseCandidate({
            api,
            repository: config.repository,
            minimumCommit: second,
            releaseTag: config.releaseTag,
            maxArtifactBytes: config.maxArtifactBytes,
          })
        : await resolveCandidate({
            api,
            ...config,
            minimumCommit: second,
          });
    await writeFile(first, `${JSON.stringify(candidate, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o400,
      flag: "wx",
    });
    process.stdout.write(`${candidate.commit}\n`);
    return;
  }

  if (command === "download" && first && second) {
    const candidate = await readCandidate(first, config);
    await recheckAny({ candidate });
    if (candidateKind(candidate) === "release") {
      await downloadReleaseAssets({
        token: config.token,
        candidate,
        destination: second,
        maxBytes: config.maxArtifactBytes,
        retry: requestContext,
      });
      process.stdout.write(`${candidate.assets.tarball.id}\n`);
      return;
    }
    await downloadArtifact({
      token: config.token,
      candidate,
      destination: second,
      maxBytes: config.maxArtifactBytes,
      retry: requestContext,
    });
    process.stdout.write(`${candidate.artifact.id}\n`);
    return;
  }

  if (command === "artifact-size" && first && !second) {
    const candidate = await readCandidate(first, config);
    if (candidateKind(candidate) === "release") {
      if (candidate.assets.tarball.sizeInBytes > config.maxArtifactBytes) {
        throw new Error(
          "candidate artifact exceeds the configured download limit",
        );
      }
      process.stdout.write(
        `${
          candidate.assets.tarball.sizeInBytes +
          candidate.assets.checksums.sizeInBytes
        }\n`,
      );
      return;
    }
    if (candidate.artifact.sizeInBytes > config.maxArtifactBytes) {
      throw new Error("candidate artifact exceeds the configured download limit");
    }
    process.stdout.write(`${candidate.artifact.sizeInBytes}\n`);
    return;
  }

  if (command === "recheck" && first && !second) {
    const candidate = await readCandidate(first, config);
    await recheckAny({ candidate });
    process.stdout.write(`${candidate.commit}\n`);
    return;
  }

  if (command === "recheck-active" && first && !second) {
    const candidate = await readCandidate(first, config);
    await recheckAny({ candidate, verifyArtifact: false });
    process.stdout.write(`${candidate.commit}\n`);
    return;
  }

  throw new Error(
    "usage: resolve-deploy-candidate.mjs current-main | target | " +
      "resolve <candidate.json> <minimum-active-commit> | " +
      "artifact-size <candidate.json> | " +
      "download <candidate.json> <artifact.zip> | recheck <candidate.json> | " +
      "recheck-active <candidate.json>",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    if (error?.code === "candidate_not_ready") {
      // Normal post-merge window: CI is still running. EX_TEMPFAIL tells the
      // puller to exit cleanly and let the next timer pass retry.
      process.stderr.write(`deploy candidate not ready: ${error.message}\n`);
      process.exitCode = 75;
      return;
    }
    process.stderr.write(`deploy candidate rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
