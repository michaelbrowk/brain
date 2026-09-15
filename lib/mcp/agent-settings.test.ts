import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_AGENT_SETTINGS_FILE,
  readAgentSettings,
  writeAgentSettings,
} from "./agent-settings";

let root: string;

beforeEach(() => {
  root = path.join(os.tmpdir(), "brain-mcp-settings-test");
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the two agent toggles", () => {
  it("tells recipients nothing and lets agents send, before anyone has chosen", async () => {
    expect(await readAgentSettings()).toEqual({
      tellRecipients: false,
      allowSending: true,
    });
  });

  it("round-trips a choice and answers it back", async () => {
    const written = await writeAgentSettings({ tellRecipients: true, allowSending: false });
    expect(written).toEqual({ tellRecipients: true, allowSending: false });
    expect(await readAgentSettings()).toEqual({ tellRecipients: true, allowSending: false });
  });

  it("writes the file under 0600 in a 0700 directory", async () => {
    await writeAgentSettings({ tellRecipients: true, allowSending: true });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, MCP_AGENT_SETTINGS_FILE))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("falls back to the defaults on a file a person edited badly", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, MCP_AGENT_SETTINGS_FILE), "{not json", {
      mode: 0o600,
    });
    expect(await readAgentSettings()).toEqual({
      tellRecipients: false,
      allowSending: true,
    });
  });

  it("keeps the default for a field the file leaves out or spells wrong", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(root, MCP_AGENT_SETTINGS_FILE),
      JSON.stringify({ tellRecipients: "yes" }),
      { mode: 0o600 },
    );
    expect(await readAgentSettings()).toEqual({
      tellRecipients: false,
      allowSending: true,
    });
  });
});
