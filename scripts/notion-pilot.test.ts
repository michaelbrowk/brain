import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { syntheticChannelSnapshot } from "../lib/notion/channel-fixture.test-helper";
import type { NotionSnapshot } from "../lib/notion/snapshot";

describe("notion-pilot CLI", () => {
  it("runs the default plan from two snapshots with no credentials or network", async () => {
    const first = await syntheticChannelSnapshot("received");
    const second = await syntheticChannelSnapshot("fresh");
    const result = await runCli([], snapshotJsonl(first) + snapshotJsonl(second));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: "plan",
      pages: 16,
      attachments: 3,
      network: false,
      mutations: false,
    });
    expect(result.stderr).toBe("");
  });

  it("fails closed without an explicit absolute journal and credentials", async () => {
    const first = await syntheticChannelSnapshot("received");
    const second = await syntheticChannelSnapshot("fresh");
    const result = await runCli(
      ["--apply"],
      snapshotJsonl(first) + snapshotJsonl(second),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "notion_pilot_failed",
    });
    expect(result.stdout).not.toContain(first.manifest.rootNotionId);
    expect(result.stdout).not.toContain("https://");
  });
});

function snapshotJsonl(snapshot: NotionSnapshot): string {
  return [
    snapshot.manifest,
    ...snapshot.pages,
    {
      type: "end",
      pageCount: snapshot.pages.length,
      assetCount: snapshot.pages.flatMap((page) => page.assets).length,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";
}

async function runCli(
  args: string[],
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["scripts/notion-pilot.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BRAIN_MCP_URL: "",
        MCP_TOKEN: "",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}
