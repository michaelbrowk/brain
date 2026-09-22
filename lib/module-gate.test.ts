import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_API_PREFIXES, moduleOfApiPath } from "./module-gate";

/** Every `route.ts` under one prefix, as the URL path it serves. The walk is
 *  the one `lib/share-write.test.ts` runs over `/api/share-edit/`, for the
 *  same reason: a route added tomorrow must be gated without anybody
 *  remembering to add it here. A `[param]` segment becomes a literal, because
 *  the gate matches on a prefix and nothing about the parameter matters. */
async function routeUrls(root: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.ts") {
        const relative = path.relative(root, path.dirname(full));
        const segments = relative === "" ? [] : relative.split(path.sep);
        out.push(
          [prefix, ...segments.map((s) => (s.startsWith("[") ? "x" : s))].join("/"),
        );
      }
    }
  }
  await walk(root);
  return out.sort();
}

describe("the module API gate", () => {
  it("claims every route file under /api/tasks", async () => {
    const root = path.join(import.meta.dirname, "..", "app", "api", "tasks");
    const urls = await routeUrls(root, "/api/tasks");
    // Two files today. A third is a new task surface and has to be argued
    // for, not discovered.
    expect(urls).toEqual(["/api/tasks", "/api/tasks/x"]);
    for (const url of urls) expect(moduleOfApiPath(url), url).toBe("tasks");
  });

  it("claims every route file under /api/mail", async () => {
    const root = path.join(import.meta.dirname, "..", "app", "api", "mail");
    const urls = await routeUrls(root, "/api/mail");
    // Every one of them, the proxy routes for attachments, remote images and
    // sender icons included: a picture fetched out of a mailbox is mail.
    expect(urls.length).toBeGreaterThanOrEqual(20);
    for (const url of urls) expect(moduleOfApiPath(url), url).toBe("mail");
  });

  // Acceptable and deliberate: with Mail off there is no connect flow to be
  // in the middle of, so the provider's redirect landing on a 409 is the
  // right answer rather than a half-finished account.
  it("claims the OAuth callback too", () => {
    expect(moduleOfApiPath("/api/mail/oauth/google/callback")).toBe("mail");
  });

  it("claims a route nested under a prefix it has never seen", () => {
    expect(moduleOfApiPath("/api/tasks/anything/at/all")).toBe("tasks");
    expect(moduleOfApiPath("/api/mail/anything/at/all")).toBe("mail");
  });

  it("claims nothing outside the prefixes", () => {
    for (const pathname of [
      "/api/tree",
      "/api/settings/modules",
      "/api/notifications",
      "/api/tasksomething",
      "/api/mailbox",
      "/api/mcp",
      "/tasks",
    ]) {
      expect(moduleOfApiPath(pathname), pathname).toBeNull();
    }
  });

  it("names each prefix once", () => {
    const names = MODULE_API_PREFIXES.map(([prefix]) => prefix);
    expect(new Set(names).size).toBe(names.length);
  });
});
