import type { ModuleSwitches } from "./modules";

/** THE ONE READING OF "IS THIS REQUEST A MODULE'S REQUEST".
 *
 *  The gate itself lives in `proxy.ts`, the file that already owns the
 *  session wall, because a refusal there is the only one that is provably
 *  ahead of the handler: no mail client is built, no store is opened, and no
 *  route file has to remember anything. The table below is what
 *  `lib/module-gate.test.ts` holds against the directories, so a route added
 *  under either prefix tomorrow is gated the day it lands.
 *
 *  `/api/mcp` is deliberately absent. An agent's call is refused in the
 *  tool's own answer shape (`app/api/mcp/module-gate.ts`), because a 409 with
 *  no `reason` field is the transport error `docs/mcp-tools.md` calls a bug. */
export type ModuleName = keyof ModuleSwitches;

export const MODULE_API_PREFIXES: readonly (readonly [string, ModuleName])[] =
  Object.freeze([
    Object.freeze(["/api/tasks", "tasks"] as const),
    Object.freeze(["/api/mail", "mail"] as const),
  ]);

export function moduleOfApiPath(pathname: string): ModuleName | null {
  for (const [prefix, module] of MODULE_API_PREFIXES) {
    // The boundary matters: `/api/tasksomething` is not a task route.
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}
