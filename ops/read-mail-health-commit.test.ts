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
  it.each(["ok", "degraded"])("accepts %s with an immutable build commit", (status) => {
    const result = parse({ apiVersion: 1, build: { commit }, status });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(commit);
    expect(result.stderr).toBe("");
  });

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
