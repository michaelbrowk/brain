import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOwnerSettingsCache, setModules } from "@/lib/owner-settings";
import { moduleGated } from "./module-gate";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-module-gate-"));
  process.env.BRAIN_SETTINGS_STATE_DIR = dir;
  resetOwnerSettingsCache(dir);
});

afterEach(async () => {
  delete process.env.BRAIN_SETTINGS_STATE_DIR;
  resetOwnerSettingsCache(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

/** A tool server that records what it was handed, so "the tool is still
 *  listed" and "the handler never ran" are both provable. */
function fakeServer() {
  const registered: { name: string; config: unknown }[] = [];
  let handler: ((input: unknown, extra: unknown) => Promise<unknown>) | null = null;
  const server = {
    registerTool(name: string, config: unknown, run: typeof handler) {
      registered.push({ name, config });
      handler = run;
    },
  };
  return { server, registered, call: () => handler!({}, {}) };
}

describe("the MCP module gate", () => {
  it.each([
    ["mail", "list_mail_accounts", "Mail is turned off in Settings › Modules"],
    ["tasks", "list_tasks", "Tasks are turned off in Settings › Modules"],
  ] as const)(
    "refuses a %s tool with the module's own sentence",
    async (module, name, sentence) => {
      await setModules({ [module]: false }, dir);
      const inner = vi.fn(async () => ({ content: [], isError: false }));
      const { server, registered, call } = fakeServer();
      moduleGated(server as never, module).registerTool(
        name,
        { title: name },
        inner as never,
      );

      // Still listed: the consent screen and the scopes do not change.
      expect(registered).toEqual([{ name, config: { title: name } }]);

      const answer = (await call()) as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(answer.isError).toBe(true);
      expect(JSON.parse(answer.content[0].text)).toEqual({
        error: sentence,
        reason: "module_off",
      });
      expect(inner).not.toHaveBeenCalled();
      // No em-dash in anything an agent prints back to a person.
      expect(sentence).not.toContain("—");
    },
  );

  it("runs the tool when the module is on", async () => {
    const inner = vi.fn(async () => ({ content: [], isError: false }));
    const { server, call } = fakeServer();
    moduleGated(server as never, "tasks").registerTool("list_tasks", {}, inner as never);
    await call();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gates only its own module", async () => {
    await setModules({ mail: false }, dir);
    const inner = vi.fn(async () => ({ content: [], isError: false }));
    const { server, call } = fakeServer();
    moduleGated(server as never, "tasks").registerTool("list_tasks", {}, inner as never);
    await call();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
