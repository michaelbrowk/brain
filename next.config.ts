import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16 locks `<distDir>/dev` per checkout, so a second `next dev` (the
  // e2e runner, the stand screenshots) cannot start next to a running one.
  // Unset in every release path; set only by tooling to a path under .next.
  ...(process.env.BRAIN_DIST_DIR ? { distDir: process.env.BRAIN_DIST_DIR } : {}),
  // Do not let unrelated lockfiles above this checkout move the standalone
  // root. A stable root makes local smoke artifacts match CI/release layout.
  turbopack: { root: process.cwd() },
  // Runtime note paths are deliberately dynamic and live outside the release.
  // Turbopack can otherwise copy repository source, tests, and .git into the
  // standalone artifact while following those filesystem calls.
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**/*",
      "./.github/**/*",
      "./.impeccable/**/*",
      "./app/**/*",
      "./components/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./lib/**/*",
      "./ops/**/*",
      "./scripts/**/*",
      "./test-results/**/*",
    ],
  },
  // `isomorphic-dompurify` loads jsdom on the server. Turbopack externalizes
  // it behind a generated `.next/node_modules/jsdom-*` alias, but Linux file
  // tracing otherwise copied only package.json into the standalone release.
  // Cold RSC page loads then failed before hydration with missing `lib/api.js`.
  // Turbopack bundles bcryptjs into a server chunk, and
  // ops/docker/brain-hash-password.mjs resolves it from the standalone tree
  // at runtime, so the package must be traced in.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/bcryptjs/**/*",
      "./node_modules/.pnpm/jsdom@*/node_modules/**/*",
      "./node_modules/.pnpm/@asamuzakjp+css-color@*/node_modules/@asamuzakjp/css-color/**/*",
      "./node_modules/.pnpm/@csstools+css-syntax-patches-for-csstree@*/node_modules/@csstools/css-syntax-patches-for-csstree/**/*",
      "./node_modules/.pnpm/decimal.js@*/node_modules/decimal.js/**/*",
      "./node_modules/.pnpm/node_modules/@asamuzakjp/generational-cache/**/*",
      "./node_modules/.pnpm/node_modules/@asamuzakjp/nwsapi/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/color-helpers/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-calc/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-color-parser/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-parser-algorithms/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-tokenizer/**/*",
      "./node_modules/.pnpm/node_modules/bidi-js/**/*",
      "./node_modules/.pnpm/node_modules/entities/**/*",
      "./node_modules/.pnpm/node_modules/lru-cache/**/*",
      "./node_modules/.pnpm/node_modules/mdn-data/**/*",
      "./node_modules/.pnpm/node_modules/punycode/**/*",
      "./node_modules/.pnpm/node_modules/require-from-string/**/*",
      "./node_modules/.pnpm/node_modules/source-map-js/**/*",
      "./node_modules/.pnpm/node_modules/tldts/**/*",
      "./node_modules/.pnpm/node_modules/tldts-core/**/*",
      "./node_modules/.pnpm/node_modules/tr46/**/*",
      "./node_modules/.pnpm/node_modules/xmlchars/**/*",
    ],
  },
  // Safe, non-secret build provenance. The deploy script sets these before
  // `next build`; CI falls back to GitHub's immutable commit SHA.
  env: {
    BRAIN_BUILD_SHA:
      process.env.BRAIN_BUILD_SHA ?? process.env.GITHUB_SHA ?? "development",
    BRAIN_BUILD_TIME:
      process.env.BRAIN_BUILD_TIME ?? new Date().toISOString(),
  },
  // Attachment URLs use a clean, versioned namespace. v2 is intentionally a
  // new cache key: the old v1 path was once public+immutable. A `_`-prefixed
  // app folder is private to Next, so both paths rewrite to the guarded route.
  async rewrites() {
    return [
      { source: "/_attachments-v2/:name", destination: "/api/media/:name" },
      { source: "/_attachments/:name", destination: "/api/media/:name" },
    ];
  },
  // security headers on every response. CSP is deliberately narrow —
  // frame-ancestors/object-src/base-uri only — a full script-src policy would
  // need per-request nonces for Next's inline hydration and Milkdown's inline
  // styles. Clickjacking + base-tag hijack are covered. Active SVG uploads are
  // rejected; hypothetical legacy SVG files are served as octet-stream
  // downloads with nosniff instead of relying on a route-specific CSP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      // The catch-all CSP above is appropriate for application pages, but
      // Next applies it after route handlers and would otherwise replace the
      // stricter attachment CSP returned by the guarded Mail binary routes.
      // Keep these overrides after the catch-all rule so browser verification
      // can safely accept the streamed bytes.
      {
        source: "/api/mail/attachments/:attachmentId",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
          },
        ],
      },
      {
        source: "/api/mail/remote-images/:remoteImageId",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
          },
        ],
      },
      {
        source: "/api/mail/sender-icon/:domain",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
