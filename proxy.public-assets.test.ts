import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("the public asset allowlist", () => {
  it("lets /sw.js through the session wall", async () => {
    // The matcher is /((?!_next/).*), so the worker script is behind the wall
    // by default. The browser refetches it to check for an update, and an
    // expired session would answer that fetch with the login page's HTML,
    // which is not a JavaScript MIME type: the update is refused and the
    // installed worker freezes at whatever version it holds, silently. The
    // file carries two pure functions and three listeners and no secret.
    const source = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    const block = /const PUBLIC_ASSETS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    expect(block).toContain('"/sw.js"');
    expect(block).toContain('"/manifest.webmanifest"');
  });

  it("keeps every notification and push route behind it", async () => {
    const source = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(source).not.toContain("/api/notifications");
    expect(source).not.toContain("/api/push");
  });
});

describe("the manifest the install depends on", () => {
  it("is a standalone app rooted at the origin, with the two icons iOS wants", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(process.cwd(), "public", "manifest.webmanifest"), "utf8"),
    );
    // iOS grants web push only to a Home-Screen app, and the install counts
    // only with a linked manifest declaring standalone display.
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes).sort()).toEqual([
      "192x192",
      "512x512",
    ]);
  });

  it("is linked from the document head", async () => {
    const layout = await readFile(path.join(process.cwd(), "app", "layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain("appleWebApp");
  });
});
