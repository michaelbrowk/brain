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
    expect(await answer.json()).toEqual({
      tellRecipients: false,
      allowSending: true,
      unreadable: false,
    });
  });

  it("writes both switches and reads them back", async () => {
    const written = await PUT(
      put(JSON.stringify({ tellRecipients: true, allowSending: false })),
    );
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({
      tellRecipients: true,
      allowSending: false,
      unreadable: false,
    });
    expect(await (await GET()).json()).toEqual({
      tellRecipients: true,
      allowSending: false,
      unreadable: false,
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
      unreadable: false,
    });
  });

  it("says so when the file holding the switches cannot be read", async () => {
    // The screen has to say what the tools do. With this file unreadable both
    // write tools refuse, so a screen drawing the on-by-default beside that
    // refusal would be telling the owner the opposite of the truth.
    await fs.writeFile(path.join(root, "agent-settings.json"), "{not json", {
      mode: 0o600,
    });

    expect(await (await GET()).json()).toEqual({
      tellRecipients: false,
      allowSending: true,
      unreadable: true,
    });

    // Writing the file again is what clears it.
    await PUT(put(JSON.stringify({ tellRecipients: false, allowSending: true })));
    expect(await (await GET()).json()).toEqual({
      tellRecipients: false,
      allowSending: true,
      unreadable: false,
    });
  });

  it("refuses a body far larger than two booleans", async () => {
    const refused = await PUT(
      put(JSON.stringify({ tellRecipients: true, allowSending: "x".repeat(4096) })),
    );
    expect(refused.status).toBe(400);
  });
});
