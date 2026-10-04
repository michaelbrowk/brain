import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const parser = path.join(process.cwd(), "ops", "read-mail-health-commit.mjs");
const commit = "a".repeat(40);

function parse(value: unknown) {
  return spawnSync(process.execPath, [parser], {
    encoding: "utf8",
    input: typeof value === "string" ? value : JSON.stringify(value),
  });
}

describe("Mail deploy health parser", () => {
  // `paused` is the owner's own request (Settings › Modules turned Mail off),
  // not a verdict about the release; the puller must still deploy through it.
  it.each(["ok", "degraded", "paused"])("accepts %s with an immutable build commit", (status) => {
    const result = parse({ apiVersion: 1, build: { commit }, status });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(commit);
    expect(result.stderr).toBe("");
  });

  // A service that sends names its SMTP byte transport in its health. The
  // puller reads the health of the release it has just started, so a field
  // the reader was written before must not stop the deploy that brings it.
  it.each(["direct", "authenticated_byte_relay"])(
    "accepts the whole health answer of a service whose send transport is %s",
    (sendTransport) => {
      const result = parse({
        apiVersion: 1,
        build: { commit, builtAt: "2026-10-04T12:00:00.000Z" },
        status: "ok",
        localSchemaVersion: 2,
        cacheSchemaVersion: 1,
        receiveReadiness: "ready",
        sendReadiness: "ready",
        activeAccounts: 1,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: 1_000,
        cachePressure: "normal",
        lastErrorCode: null,
        sendTransport,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(commit);
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    ["malformed JSON", "{"],
    ["wrong API version", { apiVersion: 2, build: { commit }, status: "ok" }],
    ["missing build", { apiVersion: 1, status: "ok" }],
    ["development commit", { apiVersion: 1, build: { commit: "dev" }, status: "ok" }],
    [
      "uppercase commit",
      { apiVersion: 1, build: { commit: "A".repeat(40) }, status: "ok" },
    ],
    ["unsupported status", { apiVersion: 1, build: { commit }, status: "unready" }],
  ])("rejects %s", (_label, value) => {
    const result = parse(value);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("rejects an oversized response", () => {
    const result = parse(" ".repeat(64 * 1024 + 1));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});
