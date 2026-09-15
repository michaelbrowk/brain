import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./route";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-agent-route-"));
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function put(body: string): Request {
  return new Request("https://brain.test/api/settings/mcp-agent", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("the agent settings route", () => {
  it("answers the documented defaults before anything is written", async () => {
    const answer = await GET();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ tellRecipients: false, allowSending: true });
  });

  it("writes both switches and reads them back", async () => {
    const written = await PUT(
      put(JSON.stringify({ tellRecipients: true, allowSending: false })),
    );
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ tellRecipients: true, allowSending: false });
    expect(await (await GET()).json()).toEqual({
      tellRecipients: true,
      allowSending: false,
    });
  });

  it("takes exactly the two keys, as booleans", async () => {
    for (const body of [
      JSON.stringify({ tellRecipients: true }),
      JSON.stringify({ tellRecipients: true, allowSending: "yes" }),
      JSON.stringify({ tellRecipients: true, allowSending: false, extra: 1 }),
      JSON.stringify([true, false]),
      "not json",
    ]) {
      const refused = await PUT(put(body));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "bad request" });
    }
    expect(await (await GET()).json()).toEqual({
      tellRecipients: false,
      allowSending: true,
    });
  });

  it("refuses a body far larger than two booleans", async () => {
    const refused = await PUT(
      put(JSON.stringify({ tellRecipients: true, allowSending: "x".repeat(4096) })),
    );
    expect(refused.status).toBe(400);
  });
});
