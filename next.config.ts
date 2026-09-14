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
      // pnpm gives jsdom its dependencies as symlinks inside the virtual
      // store, and the tracer emits BOTH the link
      // (`.pnpm/jsdom@30.0.1/node_modules/data-urls`) and paths that read
      // through it (`.../data-urls/lib/utils.js`). Next copies a trace with
      // ten concurrent workers: a worker that creates the link first leaves
      // it dangling, because the link target is never copied, and the next
      // worker's `mkdir -p` through that dangling link throws ENOENT. That
      // rejects the whole page copy, and every entry it had already claimed
      // is skipped for good. Whichever worker wins is a matter of timing,
      // which is why v0.10.1 shipped a working artifact and v0.10.2 did not.
      // Drop every dependency subtree under jsdom's store directory so no
      // link and no path through it ever reach the copier. jsdom's own files
      // stay, and its dependencies are traced from pnpm's hoisted fallback
      // below, which Node resolves from the same place at runtime.
      "./node_modules/.pnpm/jsdom@*/node_modules/!(jsdom)/**",
    ],
  },
  // `isomorphic-dompurify` loads jsdom on the server. Turbopack externalizes
  // it behind a generated `.next/node_modules/jsdom-*` alias, but Linux file
  // tracing otherwise copied only package.json into the standalone release.
  // Cold RSC page loads then failed before hydration with missing `lib/api.js`.
  // Every jsdom path here addresses a real directory. The exclude above
  // explains why a path through pnpm's dependency symlinks cannot be trusted.
  // Turbopack bundles bcryptjs into a server chunk, and
  // ops/docker/brain-hash-password.mjs resolves it from the standalone tree
  // at runtime, so the package must be traced in.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/bcryptjs/**/*",
      "./node_modules/.pnpm/jsdom@*/node_modules/jsdom/**/*",
      // jsdom's 21 declared dependencies, taken from pnpm's hoisted fallback
      // rather than from the symlinks that sit beside jsdom in the store.
      // Each of these is a real directory, so the trace carries files alone
      // and the copier has no link to leave dangling. At runtime Node walks
      // up out of jsdom's own directory and finds them in `.pnpm/node_modules`,
      // the same fallback the transitive packages below already rely on.
      // scripts/smoke-standalone.mjs asserts every one of the 21 resolves
      // from inside the artifact, so this list cannot silently fall behind.
      "./node_modules/.pnpm/node_modules/@asamuzakjp/css-color/**/*",
      "./node_modules/.pnpm/node_modules/@asamuzakjp/dom-selector/**/*",
      "./node_modules/.pnpm/node_modules/@bramus/specificity/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-syntax-patches-for-csstree/**/*",
      "./node_modules/.pnpm/node_modules/@exodus/bytes/**/*",
      "./node_modules/.pnpm/node_modules/css-tree/**/*",
      "./node_modules/.pnpm/node_modules/data-urls/**/*",
      "./node_modules/.pnpm/node_modules/decimal.js/**/*",
      "./node_modules/.pnpm/node_modules/html-encoding-sniffer/**/*",
      "./node_modules/.pnpm/node_modules/is-potential-custom-element-name/**/*",
      "./node_modules/.pnpm/node_modules/lru-cache/**/*",
      "./node_modules/.pnpm/node_modules/parse5/**/*",
      "./node_modules/.pnpm/node_modules/saxes/**/*",
      "./node_modules/.pnpm/node_modules/symbol-tree/**/*",
      "./node_modules/.pnpm/node_modules/tough-cookie/**/*",
      "./node_modules/.pnpm/node_modules/undici/**/*",
      "./node_modules/.pnpm/node_modules/w3c-xmlserializer/**/*",
      "./node_modules/.pnpm/node_modules/webidl-conversions/**/*",
      "./node_modules/.pnpm/node_modules/whatwg-mimetype/**/*",
      "./node_modules/.pnpm/node_modules/whatwg-url/**/*",
      "./node_modules/.pnpm/node_modules/xml-name-validator/**/*",
      // Packages the 21 above reach through the same hoisted fallback.
      "./node_modules/.pnpm/node_modules/@asamuzakjp/generational-cache/**/*",
      "./node_modules/.pnpm/node_modules/@asamuzakjp/nwsapi/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/color-helpers/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-calc/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-color-parser/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-parser-algorithms/**/*",
      "./node_modules/.pnpm/node_modules/@csstools/css-tokenizer/**/*",
      "./node_modules/.pnpm/node_modules/bidi-js/**/*",
      "./node_modules/.pnpm/node_modules/entities/**/*",
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
      // A route block REPLACES the catch-all rather than merging with it — the
      // three mail overrides above are the proof — so this restates the global
      // directives and then narrows. connect-src 'self' is the one that matters
      // here: the editor island may talk to this origin and to nothing else.
      //
      // img-src and media-src matter for the same reason once a link visitor
      // authors the body: without them a remote <img>, <video> or <audio> in
      // a visitor's Markdown logs the IP, User-Agent and read time of every
      // other visitor and of the owner, who opens the page to review the
      // edit. `data:` stays for inline images; a visitor's own upload is
      // same-origin. `<source srcset>`, `<svg><image>` and a legacy table
      // `background` are all governed by img-src, so the whole set closes
      // together.
      //
      // A nonce-based script-src is separate work and not a gate on this.
      // Nothing a visitor writes survives the sanitizer as script, so what is
      // still open is defence in depth for the app's own bundle rather than a
      // channel a visitor can reach.
      {
        source: "/share/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'none'; frame-src 'none'; img-src 'self' data:; media-src 'self'",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
