import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

const MAIL_BINARY_CSP =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";
// The glob that broke the v0.10.2 release. It reached through the dependency
// symlinks pnpm puts beside jsdom in the virtual store, so the trace named
// both a link and paths reading through it, and Next's concurrent copier
// raced them: whichever worker created the link first left it dangling and
// the next `mkdir -p` through it threw ENOENT, abandoning the rest of the
// copy. The artifact shipped without `data-urls` and the page render 500ed.
const SYMLINK_TRAVERSING_GLOB =
  "./node_modules/.pnpm/jsdom@*/node_modules/**/*";
const DEPENDENCY_SUBTREE_EXCLUDE =
  "./node_modules/.pnpm/jsdom@*/node_modules/!(jsdom)/**";

const jsdomDependencies = Object.keys(
  JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("jsdom/package.json"),
      "utf8",
    ),
  ).dependencies ?? {},
);

describe("Next standalone tracing", () => {
  const includes = nextConfig.outputFileTracingIncludes?.["/*"] ?? [];
  const excludes = nextConfig.outputFileTracingExcludes?.["/*"] ?? [];

  it("traces no path through pnpm's dependency symlinks beside jsdom", () => {
    expect(includes).not.toContain(SYMLINK_TRAVERSING_GLOB);
    expect(excludes).toContain(DEPENDENCY_SUBTREE_EXCLUDE);
  });

  it("carries every jsdom dependency from the hoisted fallback", () => {
    expect(jsdomDependencies.length).toBeGreaterThan(0);
    for (const dependency of jsdomDependencies) {
      expect(includes).toContain(
        `./node_modules/.pnpm/node_modules/${dependency}/**/*`,
      );
    }
  });

  it("keeps jsdom's own files, which the exclude deliberately spares", () => {
    expect(includes).toContain(
      "./node_modules/.pnpm/jsdom@*/node_modules/jsdom/**/*",
    );
  });
});

describe("Next response headers", () => {
  it("overrides the page CSP for guarded Mail binary routes", async () => {
    const rules = await nextConfig.headers?.();

    expect(rules).toBeDefined();
    const catchAllIndex = rules!.findIndex((rule) => rule.source === "/:path*");

    for (const source of [
      "/api/mail/attachments/:attachmentId",
      "/api/mail/remote-images/:remoteImageId",
      "/api/mail/sender-icon/:domain",
    ]) {
      const ruleIndex = rules!.findIndex((rule) => rule.source === source);
      expect(ruleIndex).toBeGreaterThan(catchAllIndex);
      expect(rules![ruleIndex]?.headers).toContainEqual({
        key: "Content-Security-Policy",
        value: MAIL_BINARY_CSP,
      });
    }
  });
});

const SHARE_CSP =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'none'; frame-src 'none'; img-src 'self' data:; media-src 'self'";

describe("the /share surface", () => {
  it("carries exactly one CSP, after the catch-all, with connect-src 'self'", async () => {
    const rules = await nextConfig.headers?.();
    const catchAllIndex = rules!.findIndex((rule) => rule.source === "/:path*");
    const shareIndex = rules!.findIndex((rule) => rule.source === "/share/:path*");

    expect(shareIndex).toBeGreaterThan(catchAllIndex);
    const csp = rules![shareIndex]!.headers.filter(
      (header) => header.key === "Content-Security-Policy",
    );
    expect(csp).toHaveLength(1);
    expect(csp[0]!.value).toBe(SHARE_CSP);
  });

  it("gives a visitor-authored body no way to fetch a remote subresource", async () => {
    // A visitor writes the body other visitors and the owner then load. With
    // no img-src and no media-src, a remote <img>, <video> or <audio> logs
    // every reader's IP, User-Agent and read time to whoever wrote it.
    const rules = await nextConfig.headers?.();
    const share = rules!.find((rule) => rule.source === "/share/:path*")!;
    const csp = share.headers.find(
      (header) => header.key === "Content-Security-Policy",
    )!.value;
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("media-src 'self'");
  });

  it("keeps a shared page out of search results and out of every cache", async () => {
    const rules = await nextConfig.headers?.();
    const share = rules!.find((rule) => rule.source === "/share/:path*")!;
    expect(share.headers).toContainEqual({
      key: "X-Robots-Tag",
      value: "noindex, nofollow",
    });
    expect(share.headers).toContainEqual({
      key: "Cache-Control",
      value: "private, no-store",
    });
  });
});

describe("the service worker's headers", () => {
  it("serves /sw.js with Service-Worker-Allowed: / and no cache", async () => {
    const rules = await nextConfig.headers?.();
    const catchAllIndex = rules!.findIndex((rule) => rule.source === "/:path*");
    const swIndex = rules!.findIndex((rule) => rule.source === "/sw.js");
    // A route block REPLACES the catch-all, so this one has to come after it
    // and restate whatever of the global set it still wants.
    expect(swIndex).toBeGreaterThan(catchAllIndex);
    expect(rules![swIndex]!.headers).toContainEqual({
      key: "Service-Worker-Allowed",
      value: "/",
    });
    expect(rules![swIndex]!.headers).toContainEqual({
      key: "Cache-Control",
      value: "no-cache",
    });
  });

  it("leaves the content type to the static route that serves the file", async () => {
    // One header, one source. `public/sw.js` goes out through Next's own
    // static route, which types a `.js` file already; a second answer here
    // could disagree with it and both would look right in review. The served
    // header is asserted end to end in `e2e/notifications.spec.ts`.
    const rules = await nextConfig.headers?.();
    const sw = rules!.find((rule) => rule.source === "/sw.js")!;
    expect(sw.headers.map((header) => header.key)).not.toContain("Content-Type");
  });

  it("keeps a CSP on the worker that does not block it", async () => {
    // The catch-all CSP names frame-ancestors, object-src and base-uri only.
    // There is no script-src and no worker-src anywhere in the config, so
    // nothing here stops a same-origin worker from registering or running.
    const rules = await nextConfig.headers?.();
    for (const rule of rules!) {
      const csp = rule.headers.find((header) => header.key === "Content-Security-Policy")?.value;
      if (!csp) continue;
      if (rule.source === "/api/mail/attachments/:attachmentId") continue;
      if (rule.source === "/api/mail/remote-images/:remoteImageId") continue;
      if (rule.source === "/api/mail/sender-icon/:domain") continue;
      expect(csp).not.toContain("worker-src");
      expect(csp).not.toContain("script-src");
    }
  });
});
