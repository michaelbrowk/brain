import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpStateDirectory } from "./state-dir";

describe("mcpStateDirectory", () => {
  it("takes the override ahead of everything else", () => {
    expect(
      mcpStateDirectory({ NODE_ENV: "production", BRAIN_MCP_STATE_DIR: "/srv/mcp" }),
    ).toBe("/srv/mcp");
  });

  it("lands beside the other state directories in production", () => {
    expect(mcpStateDirectory({ NODE_ENV: "production" })).toBe("/var/lib/brain/mcp");
  });

  it("keeps development out of /var/lib and per user", () => {
    const dir = mcpStateDirectory({ NODE_ENV: "development" });
    expect(path.dirname(dir)).toBe(os.tmpdir());
    expect(path.basename(dir)).toMatch(/^brain-mcp-/);
  });
});
