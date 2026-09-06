import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

const MAIL_BINARY_CSP =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";
const DECIMAL_JS_STANDALONE_GLOB =
  "./node_modules/.pnpm/decimal.js@*/node_modules/decimal.js/**/*";
const CSS_COLOR_STANDALONE_GLOB =
  "./node_modules/.pnpm/@asamuzakjp+css-color@*/node_modules/@asamuzakjp/css-color/**/*";
const CSS_SYNTAX_PATCHES_STANDALONE_GLOB =
  "./node_modules/.pnpm/@csstools+css-syntax-patches-for-csstree@*/node_modules/@csstools/css-syntax-patches-for-csstree/**/*";

describe("Next standalone tracing", () => {
  it("includes jsdom's exact runtime targets in the standalone artifact", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/*"]).toContain(
      DECIMAL_JS_STANDALONE_GLOB,
    );
    expect(nextConfig.outputFileTracingIncludes?.["/*"]).toContain(
      CSS_COLOR_STANDALONE_GLOB,
    );
    expect(nextConfig.outputFileTracingIncludes?.["/*"]).toContain(
      CSS_SYNTAX_PATCHES_STANDALONE_GLOB,
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
