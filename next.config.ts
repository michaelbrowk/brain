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
  // Runtime note paths are deliberately dynamic and live outside the release,
  // and a tracer following those filesystem calls copies repository source,
  // tests and .git into the standalone artifact. This list names what it must
  // not take.
  //
  // MEASURED, AND IT IS NOT HONOURED TODAY. The 0.13.0 build carries `app/`,
  // `docs/`, `.git` and every other directory named below into
  // `.next/standalone` regardless, which is this Turbopack rather than this
  // list: the entries are correct and inert. They stay, because the day the
  // tracer reads them is not a day anybody will think to write them, and
  // because the jsdom exclude two entries down IS read and is load-bearing
  // (see its own comment). Do not read a green build as evidence that a new
  // entry here works; measure the artifact.
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**/*",
      "./.github/**/*",
      "./.impeccable/**/*",
      "./app/**/*",
      "./components/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./examples/**/*",
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
  // frame-ancestors/object-src/base-uri/frame-src only — a full script-src
  // policy would need per-request nonces for Next's inline hydration and
  // Milkdown's inline styles. Clickjacking + base-tag hijack are covered.
  // Active SVG uploads are rejected; hypothetical legacy SVG files are served
  // as octet-stream downloads with nosniff instead of relying on a
  // route-specific CSP.
  //
  // RULES ACCUMULATE, THEY DO NOT REPLACE. Next matches every rule below whose
  // source matches the path and writes each header into one object, last value
  // winning per key, and nothing downstream can remove a key a rule set: a
  // route handler's own header is appended only where the key is absent. So a
  // later block that omits a header does not drop it, and the only way to keep
  // a header off a path is for no matching rule to set it.
  //
  // That is why this source names a negative lookahead rather than `/:path*`.
  // An app's frame is served from `/api/app/`, and X-Frame-Options: DENY makes
  // that document unloadable in a frame while this CSP's frame-ancestors
  // 'none' would be enforced alongside the route's own policy as the
  // intersection of the two. Both would be invisible: a CSP violation inside
  // an opaque-origin frame is reported to nobody. Everything else, `/api/app`
  // with no file after it included, still gets the global set.
  //
  // frame-src 'self' is here for the frame this exempts: connect-src governs
  // fetch and not navigation, and a nested context's navigation is governed by
  // its PARENT's policy, which is this one. Without it an app could put
  // anything the bridge hands it into its own address bar and navigate to
  // another origin. The mail reader's message frame is a `srcdoc`, which
  // renders without a navigation request and so is not governed by frame-src.
  async headers() {
    return [
      {
        source: "/((?!api/app/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; frame-src 'self'",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
      // The push service worker. This block adds to the catch-all rather than
      // replacing it, so the four global headers it restates are restatements
      // of the same values and the two below are what it adds. The CSP is NOT
      // dropped by being left out — the catch-all above still sets it on this
      // path, and nothing here could remove it. It is left out because
      // repeating it would be a second place to keep in step with the first:
      // frame-ancestors, object-src and base-uri govern a document and say
      // nothing about a script response.
      //
      // THE CONTENT TYPE IS NOT SET HERE. `public/sw.js` is served by Next's
      // own static route, which types a `.js` file
      // `application/javascript; charset=UTF-8` already. Restating it made two
      // places responsible for one header, and the two can disagree while both
      // look right in review. The route types the file; this block says what
      // the browser may do with it. `e2e/notifications.spec.ts` reads the
      // served header, so a platform that stopped typing it is a red test
      // rather than a worker that silently never registers.
      //
      // Service-Worker-Allowed is not strictly needed while the script sits at
      // the root and controls the root, and it is set anyway: it states the
      // scope the worker is meant to have, so moving the file later is a
      // decision rather than an accident.
      //
      // no-cache, because a stale worker cannot be replaced by the page that
      // needs replacing: the browser checks this file for an update and a
      // cached copy makes that check a no-op.
      {
        source: "/sw.js",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Cache-Control", value: "no-cache" },
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
      // This block comes after the catch-all, so for a key both set its value
      // is the one that stands — which is how this CSP replaces the global one
      // on a share page. It restates the global directives and then narrows.
      // connect-src 'self' is the one that matters here: the editor island may
      // talk to this origin and to nothing else.
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
      //
      // frame-src is 'self' rather than 'none' because a shared page
      // can BE an app: `kind: app` renders the same sandboxed frame
      // the owner sees, served from this origin. The directive reads
      // the frame's URL, which is same-origin; the opaque origin the
      // sandbox gives the document inside it is not what is measured
      // here. No other source is allowed, so a visitor's Markdown
      // still cannot frame anything at all.
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
              "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'none'; frame-src 'self'; img-src 'self' data:; media-src 'self'",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      // An app's own files. These are the paths the catch-all's lookahead
      // exempts, so this is the only rule that names them and the four headers
      // below are the whole set the response carries out of this file. Two
      // headers are deliberately absent and could not be removed here if they
      // were not: X-Frame-Options, because DENY makes an app unloadable inside
      // the page that IS the app, and the CSP, because only the route handler
      // can build one that names the public origin and this app's id.
      {
        source: "/api/app/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
