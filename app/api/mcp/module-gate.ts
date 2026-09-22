import type { createMcpHandler } from "mcp-handler";
import { readModules } from "@/lib/owner-settings";
import type { ModuleName } from "@/lib/module-gate";
import { moduleOff } from "./tool-kit";

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

/** EVERY TOOL OF ONE MODULE, GATED IN ONE PLACE.
 *
 *  `route.ts` calls four registrars, and between them they register the ten
 *  mail tools and the eight task tools. A check written into each handler
 *  would be eighteen chances to forget one, and a forgotten one is a tool
 *  that answers normally out of a module the owner switched off. So the
 *  server itself is wrapped where the registrar is called: every tool
 *  registered through the returned object carries the gate, including one
 *  added tomorrow.
 *
 *  Registration is untouched, which is the point of doing it here rather than
 *  by not registering at all: the tool stays in `tools/list`, the consent
 *  screen and the scopes do not change, and an agent that calls it gets a
 *  refusal it can read instead of a name that has silently disappeared. The
 *  activity log records it like any other refusal.
 *
 *  `Object.create` and not a spread, so the prototype and every other method
 *  of the real server are still there; the wrapper calls `server.registerTool`
 *  on the original, so `this` is the original too. */
export function moduleGated(server: McpToolServer, module: ModuleName): McpToolServer {
  const gated: McpToolServer = Object.create(server);
  gated.registerTool = ((name, config, run) =>
    server.registerTool(name, config, (async (...args: unknown[]) => {
      if ((await readModules())[module]) {
        return (run as (...a: unknown[]) => unknown)(...args);
      }
      return moduleOff(module);
    }) as typeof run)) as McpToolServer["registerTool"];
  return gated;
}
