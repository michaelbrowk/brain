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
