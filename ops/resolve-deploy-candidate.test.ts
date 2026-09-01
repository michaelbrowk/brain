import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_STORAGE_TIMEOUT_MS,
  RESOLVER_NETWORK_DEADLINE_MS,
  allowedDownloadHost,
  apiClient,
  configuration,
  downloadArtifact,
  downloadReleaseAssets,
  parseChecksums,
  parseDeployerEnvironment,
} from "./resolve-deploy-candidate.mjs";

const roots: string[] = [];
const commit = "a".repeat(40);
const repositoryId = 1_296_646_939;
const token = "test_read_only_token_abcdefghijklmnopqrstuvwxyz";

function retryHarness(initialNow = Date.parse("2026-07-20T00:00:00Z")) {
  let currentNow = initialNow;
  const sleeps: number[] = [];
  return {
    retry: {
      now: () => currentNow,
      wallNow: () => currentNow,
      sleep: vi.fn(async (milliseconds: number) => {
        sleeps.push(milliseconds);
        currentNow += milliseconds;
      }),
    },
    sleeps,
    advance(milliseconds: number) {
      currentNow += milliseconds;
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function candidate(payload: Buffer, digest = createHash("sha256").update(payload).digest("hex")) {
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
      sizeInBytes: payload.length,
      digest: `sha256:${digest}`,
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

describe("bounded GitHub retries", () => {
  it("retries an exact JSON API GET with 1s/2s backoff and cancels failed bodies", async () => {
    const path = `/repos/michaelbrowk/brain/commits/${commit}`;
    const failed = [
      new Response("private failure one", {
        status: 503,
        headers: { "x-github-request-id": "retry-one" },
      }),
      new Response("private failure two", {
        status: 502,
        headers: { "x-github-request-id": "retry-two" },
      }),
    ];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(failed[0])
      .mockResolvedValueOnce(failed[1])
      .mockResolvedValueOnce(
        Response.json({ sha: commit }, { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(apiClient(token, retry)(path)).resolves.toEqual({ sha: commit });

    expect(sleeps).toEqual([1_000, 2_000]);
    expect(failed.every((response) => response.bodyUsed)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    const requests = fetch.mock.calls as Array<[string, RequestInit]>;
    expect(requests.map(([url]) => url)).toEqual([
      `https://api.github.com${path}`,
      `https://api.github.com${path}`,
      `https://api.github.com${path}`,
    ]);
    for (const [, init] of requests) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(init.headers).toEqual(requests[0][1].headers);
    }
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "retries the allowlisted GitHub status %i",
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("private", { status }))
        .mockResolvedValueOnce(Response.json({ sha: commit }));
      vi.stubGlobal("fetch", fetch);
      const { retry, sleeps } = retryHarness();

      await expect(
        apiClient(token, retry)("/repos/michaelbrowk/brain"),
      ).resolves.toEqual({ sha: commit });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([1_000]);
    },
  );

  it("stops after four attempts and keeps only status plus request id", async () => {
    const responses = [1, 2, 3, 4].map(
      (attempt) =>
        new Response(`private body ${attempt}`, {
          status: 503,
          headers: { "x-github-request-id": `request-${attempt}` },
        }),
    );
    const fetch = vi.fn();
    for (const response of responses) fetch.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    const failure = await apiClient(token, retry)("/repos/michaelbrowk/brain")
      .then(() => null)
      .catch((error: Error) => error);

    expect(failure?.message).toBe(
      "GitHub API returned 503 (request request-4)",
    );
    expect(failure?.message).not.toContain("private body");
    expect(failure?.message).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("honors Retry-After seconds and dates without exceeding the sleep budget", async () => {
    const initialNow = Date.parse("2026-07-20T00:00:00Z");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 503,
          headers: {
            "retry-after": new Date(initialNow + 5_000).toUTCString(),
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ sha: commit }));
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness(initialNow);

    await expect(
      apiClient(token, retry)("/repos/michaelbrowk/brain"),
    ).resolves.toEqual({ sha: commit });
    expect(sleeps).toEqual([2_000, 3_000]);
  });

  it("retries 403 only when Retry-After is valid", async () => {
    const withoutRetryAfter = vi.fn().mockResolvedValue(
      new Response("private", {
        status: 403,
        headers: { "x-github-request-id": "forbidden-now" },
      }),
    );
    vi.stubGlobal("fetch", withoutRetryAfter);
    const firstHarness = retryHarness();
    await expect(
      apiClient(token, firstHarness.retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API returned 403 (request forbidden-now)");
    expect(withoutRetryAfter).toHaveBeenCalledTimes(1);
    expect(firstHarness.sleeps).toEqual([]);

    const invalidRetryAfter = vi.fn().mockResolvedValue(
      new Response("private", {
        status: 403,
        headers: { "retry-after": "soon" },
      }),
    );
    vi.stubGlobal("fetch", invalidRetryAfter);
    const invalidHarness = retryHarness();
    await expect(
      apiClient(token, invalidHarness.retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API returned 403 (request unknown)");
    expect(invalidRetryAfter).toHaveBeenCalledTimes(1);
    expect(invalidHarness.sleeps).toEqual([]);

    const withRetryAfter = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 403, headers: { "retry-after": "1" } }),
      )
      .mockResolvedValueOnce(Response.json({ sha: commit }));
    vi.stubGlobal("fetch", withRetryAfter);
    const secondHarness = retryHarness();
    await expect(
      apiClient(token, secondHarness.retry)("/repos/michaelbrowk/brain"),
    ).resolves.toEqual({ sha: commit });
    expect(withRetryAfter).toHaveBeenCalledTimes(2);
    expect(secondHarness.sleeps).toEqual([1_000]);
  });

  it.each([
    "0.5",
    "garbage",
    "9007199254740992",
    "Sun, 19 Jul 2026 23:59:59 GMT",
    "Sun, 20 Jul 2026 00:00:05 GMT",
    "Mon, 32 Jul 2026 00:00:05 GMT",
  ])("rejects malformed or expired Retry-After %s", async (retryAfter) => {
    const response = new Response("private", {
      status: 403,
      headers: {
        "retry-after": retryAfter,
        "x-github-request-id": "strict-retry-after",
      },
    });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      apiClient(token, retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow(
      "GitHub API returned 403 (request strict-retry-after)",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(response.bodyUsed).toBe(true);
  });

  it("fails before sleeping when Retry-After exceeds the remaining budget", async () => {
    const responses = [
      new Response("private first response", {
        status: 503,
        headers: { "retry-after": "20", "x-github-request-id": "first" },
      }),
      new Response("private second response", {
        status: 503,
        headers: { "retry-after": "11", "x-github-request-id": "second" },
      }),
    ];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      apiClient(token, retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API returned 503 (request second)");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([20_000]);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("retries only TypeError and TimeoutError transport failures", async () => {
    const timeout = Object.assign(new Error("private timeout"), {
      name: "TimeoutError",
    });
    const transientFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("private network detail"))
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(Response.json({ sha: commit }));
    vi.stubGlobal("fetch", transientFetch);
    const transientHarness = retryHarness();
    await expect(
      apiClient(token, transientHarness.retry)("/repos/michaelbrowk/brain"),
    ).resolves.toEqual({ sha: commit });
    expect(transientHarness.sleeps).toEqual([1_000, 2_000]);

    const permanentFetch = vi
      .fn()
      .mockRejectedValue(new Error("private permanent detail"));
    vi.stubGlobal("fetch", permanentFetch);
    const permanentHarness = retryHarness();
    await expect(
      apiClient(token, permanentHarness.retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API request failed");
    expect(permanentFetch).toHaveBeenCalledTimes(1);
    expect(permanentHarness.sleeps).toEqual([]);
  });

  it("stops transport retries after four sanitized attempts", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new TypeError(`private ${token}`));
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    const failure = await apiClient(token, retry)("/repos/michaelbrowk/brain")
      .then(() => null)
      .catch((error: Error) => error);
    expect(failure?.message).toBe("GitHub API request failed");
    expect(failure?.message).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("does not retry request-construction TypeError", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      apiClient("invalid\ntoken", retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API request failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("shares one command deadline across API calls", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sha: commit }))
      .mockRejectedValue(new TypeError("private network detail"));
    vi.stubGlobal("fetch", fetch);
    const harness = retryHarness();
    const api = apiClient(token, harness.retry);

    await expect(api("/repos/michaelbrowk/brain/first")).resolves.toEqual({
      sha: commit,
    });
    harness.advance(RESOLVER_NETWORK_DEADLINE_MS - 500);
    await expect(api("/repos/michaelbrowk/brain/second")).rejects.toThrow(
      "GitHub API request failed",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(harness.sleeps).toEqual([]);
  });

  it.each([401, 404, 422])("never retries GitHub status %i", async (status) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("private", {
        status,
        headers: { "x-github-request-id": `request-${status}` },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      apiClient(token, retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow(
      `GitHub API returned ${status} (request request-${status})`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries malformed JSON from a successful API response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("private malformed body", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    const failure = await apiClient(token, retry)("/repos/michaelbrowk/brain")
      .then(() => null)
      .catch((error: Error) => error);
    expect(failure?.message).toBe("GitHub API returned malformed JSON");
    expect(failure?.message).not.toContain("private malformed body");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("rejects an API redirect without following or retrying it", async () => {
    const response = new Response("private redirect body", {
      status: 302,
      headers: {
        location: "https://example.com/private",
        "x-github-request-id": "redirect-blocked",
      },
    });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      apiClient(token, retry)("/repos/michaelbrowk/brain"),
    ).rejects.toThrow("GitHub API returned 302 (request redirect-blocked)");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
    expect(sleeps).toEqual([]);
    expect(response.bodyUsed).toBe(true);
  });

  it("keeps the command network deadline inside the resolver cgroup runtime", async () => {
    const puller = await fs.readFile(
      path.join(process.cwd(), "ops/deploy-puller.sh"),
      "utf8",
    );
    const runtimeMinutes = Number(
      /--property=RuntimeMaxSec=(\d+)min/.exec(puller)?.[1],
    );
    const runtimeMilliseconds = runtimeMinutes * 60 * 1_000;

    expect(runtimeMinutes).toBe(15);
    expect(ARTIFACT_STORAGE_TIMEOUT_MS).toBe(10 * 60 * 1_000);
    expect(RESOLVER_NETWORK_DEADLINE_MS).toBe(14 * 60 * 1_000);
    expect(
      RESOLVER_NETWORK_DEADLINE_MS + 60 * 1_000,
    ).toBeLessThanOrEqual(runtimeMilliseconds);
    expect(ARTIFACT_STORAGE_TIMEOUT_MS).toBeLessThan(
      RESOLVER_NETWORK_DEADLINE_MS,
    );
  });

  it("cuts off a signed-storage body at the remaining command deadline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-deadline-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const payload = Buffer.from("x");
    const initialNow = Date.parse("2026-07-20T00:00:00Z");
    const harness = retryHarness(initialNow);
    const requestContext = {
      ...harness.retry,
      deadlineAt: initialNow + 25,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
          },
        }),
      )
      .mockImplementationOnce(
        async (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(payload);
                init.signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("deadline reached")),
                  { once: true },
                );
              },
            }),
            {
              status: 200,
              headers: { "content-length": String(payload.length) },
            },
          ),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      downloadArtifact({
        token,
        candidate: candidate(payload),
        destination,
        maxBytes: 1024,
        retry: requestContext,
      }),
    ).rejects.toThrow("deadline reached");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes an invalid GitHub request id", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("private", {
        status: 401,
        headers: { "x-github-request-id": token },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const failure = await apiClient(token)("/repos/michaelbrowk/brain")
      .then(() => null)
      .catch((error: Error) => error);
    expect(failure?.message).toBe("GitHub API returned 401 (request unknown)");
    expect(failure?.message).not.toContain(token);
  });

  it("shares retries with the artifact redirect and never retries storage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-retry-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const payload = Buffer.from("trusted artifact zip");
    const retryResponse = new Response("private", {
      status: 503,
      headers: { "x-github-request-id": "artifact-retry" },
    });
    const storageResponse = new Response("private storage body", {
      status: 503,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
          },
        }),
      )
      .mockResolvedValueOnce(storageResponse);
    vi.stubGlobal("fetch", fetch);
    const { retry, sleeps } = retryHarness();

    await expect(
      downloadArtifact({
        token,
        candidate: candidate(payload),
        destination,
        maxBytes: 1024,
        retry,
      }),
    ).rejects.toThrow("artifact storage returned 503");

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000]);
    expect(retryResponse.bodyUsed).toBe(true);
    expect(storageResponse.bodyUsed).toBe(true);
    const requests = fetch.mock.calls as Array<[string, RequestInit]>;
    expect(requests[0][0]).toBe(requests[1][0]);
    expect(requests[0][1].headers).toEqual(requests[1][1].headers);
    expect(requests[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(requests[1][1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(requests[2][1].headers).toBeUndefined();
  });
});

describe("artifact download", () => {
  it("parses the systemd credential without accepting unknown or duplicate keys", () => {
    expect(
      parseDeployerEnvironment(
        [
          "BRAIN_DEPLOY_GITHUB_TOKEN=test_read_only_token_abcdefghijklmnopqrstuvwxyz",
          "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain",
          "BRAIN_DEPLOY_ALLOWED_MERGERS=michaelbrowk:4010101",
          "",
        ].join("\n"),
      ),
    ).toMatchObject({
      BRAIN_DEPLOY_REPOSITORY: "michaelbrowk/brain",
      BRAIN_DEPLOY_ALLOWED_MERGERS: "michaelbrowk:4010101",
    });
    expect(() =>
      parseDeployerEnvironment("UNEXPECTED_SECRET=value\n"),
    ).toThrow("not allowed");
    expect(() =>
      parseDeployerEnvironment(
        "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain\n" +
          "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain\n",
      ),
    ).toThrow("repeats");
  });

  it("keeps production credentials and SSH out of GitHub workflows", async () => {
    const workflowDirectory = path.join(process.cwd(), ".github/workflows");
    const names = await fs.readdir(workflowDirectory);
    const sources = await Promise.all(
      names
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => fs.readFile(path.join(workflowDirectory, name), "utf8")),
    );
    expect(names).not.toContain("deploy.yml");
    expect(sources.join("\n")).not.toMatch(
      /BRAIN_DEPLOY_GITHUB_TOKEN|BRAIN_DEPLOY_SSH|SSH_PRIVATE_KEY|\bssh\b/i,
    );
  });

  it("allows only known GitHub artifact storage hosts", () => {
    expect(allowedDownloadHost("productionresultssa.blob.core.windows.net")).toBe(
      true,
    );
    expect(allowedDownloadHost("results.actions.githubusercontent.com")).toBe(true);
    expect(allowedDownloadHost("objects.githubusercontent.com")).toBe(true);
    expect(allowedDownloadHost("blob.core.windows.net.attacker.test")).toBe(false);
    expect(allowedDownloadHost("example.com")).toBe(false);
  });

  it("pins the GitHub digest and never forwards the token to object storage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const payload = Buffer.from("trusted artifact zip");
    const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push([url, init]);
        if (requests.length === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
            },
          });
        }
        return new Response(payload, {
          status: 200,
          headers: { "content-length": String(payload.length) },
        });
      }),
    );

    await downloadArtifact({
      token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
      candidate: candidate(payload),
      destination,
      maxBytes: 1024,
    });

    expect(await fs.readFile(destination)).toEqual(payload);
    expect(requests).toHaveLength(2);
    expect(requests[0][1]?.headers).toMatchObject({
      Authorization: "Bearer test_read_only_token_abcdefghijklmnopqrstuvwxyz",
    });
    expect(requests[1][1]?.headers).toBeUndefined();
  });

  it("rejects an untrusted redirect or digest mismatch without a final file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const payload = Buffer.from("tampered artifact zip");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/artifact.zip" },
          }),
        ),
    );
    await expect(
      downloadArtifact({
        token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
        candidate: candidate(payload),
        destination,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("untrusted host");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
            },
          }),
        )
        .mockResolvedValueOnce(new Response(payload, { status: 200 })),
    );
    await expect(
      downloadArtifact({
        token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
        candidate: candidate(payload, "0".repeat(64)),
        destination,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("digest does not match");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires downloaded bytes and declared length to equal the pinned size", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-size-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const pinned = Buffer.from("1234567890");
    const shorter = pinned.subarray(0, 9);
    const declaredMismatch = new Response(shorter, {
      status: 200,
      headers: { "content-length": String(shorter.length) },
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
            },
          }),
        )
        .mockResolvedValueOnce(declaredMismatch),
    );
    await expect(
      downloadArtifact({
        token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
        candidate: candidate(pinned),
        destination,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("length differs from pinned metadata");
    expect(declaredMismatch.bodyUsed).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://productionresultssa.blob.core.windows.net/pinned/artifact.zip",
            },
          }),
        )
        .mockResolvedValueOnce(new Response(shorter, { status: 200 })),
    );
    await expect(
      downloadArtifact({
        token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
        candidate: candidate(pinned),
        destination,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("size does not match GitHub metadata");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects candidate cross-field actor provenance before downloading", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-download-candidate-"));
    roots.push(root);
    const destination = path.join(root, "artifact.zip");
    const payload = Buffer.from("trusted artifact zip");
    const malformed = candidate(payload);
    malformed.workflow.triggeringActorId = 99;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      downloadArtifact({
        token: "test_read_only_token_abcdefghijklmnopqrstuvwxyz",
        candidate: malformed,
        destination,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("actor or repository provenance");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses SHA256SUMS strictly", () => {
    const digest = "e".repeat(64);
    expect(
      parseChecksums(`${digest}  brain-0.9.0-linux-x64.tar.gz\n`, "brain-0.9.0-linux-x64.tar.gz"),
    ).toBe(digest);
    expect(() =>
      parseChecksums(`${digest} brain-0.9.0-linux-x64.tar.gz\n`, "brain-0.9.0-linux-x64.tar.gz"),
    ).toThrow("malformed line");
    expect(() =>
      parseChecksums(`${digest}  other.tar.gz\n`, "brain-0.9.0-linux-x64.tar.gz"),
    ).toThrow("exactly once");
  });

  it("downloads SHA256SUMS first, then the tarball pinned to its line, without forwarding the token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-download-"));
    roots.push(root);
    const tarball = Buffer.from("release tarball bytes");
    const digest = createHash("sha256").update(tarball).digest("hex");
    const sums = Buffer.from(`${digest}  brain-0.9.0-linux-x64.tar.gz\n`);
    const candidate = {
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
        tarball: {
          id: 11,
          name: "brain-0.9.0-linux-x64.tar.gz",
          sizeInBytes: tarball.length,
        },
        checksums: { id: 12, name: "SHA256SUMS", sizeInBytes: sums.length },
      },
      resolvedAt: "2026-07-12T10:05:00Z",
    };
    const requests: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        requests.push([href, init]);
        if (href.endsWith("/releases/assets/12")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/sums" },
          });
        }
        if (href.endsWith("/releases/assets/11")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/tarball" },
          });
        }
        if (href.endsWith("/sums")) {
          return new Response(sums, {
            status: 200,
            headers: { "content-length": String(sums.length) },
          });
        }
        return new Response(tarball, {
          status: 200,
          headers: { "content-length": String(tarball.length) },
        });
      }),
    );
    const destination = path.join(root, "artifact");
    await expect(
      downloadReleaseAssets({ token, candidate, destination, maxBytes: 1024 }),
    ).resolves.toBe(digest);
    expect(await fs.readFile(destination)).toEqual(tarball);
    expect(await fs.readFile(path.join(root, "SHA256SUMS"))).toEqual(sums);
    expect(await fs.readFile(`${destination}.sha256`, "utf8")).toBe(`${digest}\n`);
    expect(requests.map(([href]) => href.split("/").pop())).toEqual([
      "12",
      "sums",
      "11",
      "tarball",
    ]);
    expect(requests[0][1]?.headers).toMatchObject({
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
    });
    expect(requests[1][1]?.headers).toBeUndefined();
  });

  it("accepts the release source and the pin in the systemd credential", () => {
    expect(
      parseDeployerEnvironment(
        "BRAIN_DEPLOY_SOURCE=release\nBRAIN_DEPLOY_RELEASE_TAG=v0.9.0-rc.1\n",
      ),
    ).toEqual({
      BRAIN_DEPLOY_SOURCE: "release",
      BRAIN_DEPLOY_RELEASE_TAG: "v0.9.0-rc.1",
    });
  });

  it("requires the merger allowlist for the ci source only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-config-"));
    roots.push(root);
    const credential = (lines: string[]) =>
      fs.writeFile(path.join(root, "deployer-env"), `${lines.join("\n")}\n`);
    vi.stubEnv("CREDENTIALS_DIRECTORY", root);
    try {
      await credential([
        `BRAIN_DEPLOY_GITHUB_TOKEN=${token}`,
        "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain",
      ]);
      await expect(configuration()).rejects.toThrow(
        "BRAIN_DEPLOY_ALLOWED_MERGERS is required",
      );
      await credential([
        `BRAIN_DEPLOY_GITHUB_TOKEN=${token}`,
        "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain",
        "BRAIN_DEPLOY_SOURCE=release",
      ]);
      await expect(configuration()).resolves.toMatchObject({
        source: "release",
        allowedMergers: null,
      });
      await credential([
        `BRAIN_DEPLOY_GITHUB_TOKEN=${token}`,
        "BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain",
        "BRAIN_DEPLOY_SOURCE=release",
        "BRAIN_DEPLOY_ALLOWED_MERGERS=michaelbrowk:4010101",
      ]);
      await expect(configuration()).resolves.toMatchObject({
        source: "release",
        allowedMergers: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
