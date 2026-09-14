import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // A run under BRAIN_DIST_DIR (`.next-nav`, and the isolated dist dirs the
    // owner-gated shot specs use) puts a build tree beside it under another
    // name, and only the one name is ignored — so the SECOND `pnpm check`
    // lints Next's own compiled chunks and fails on `require()` inside them.
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["ops/brain-server.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // The push worker runs in ServiceWorkerGlobalScope, which is neither a
    // window nor Node. `sourceType: "script"` is what a classic worker is,
    // and it is the half of this block that changes anything today.
    //
    // The globals are insurance, not a fix: `eslint --print-config
    // public/sw.js` reports `no-undef` unset, because eslint-config-next
    // leaves undefined names to TypeScript, and TypeScript never reads this
    // file (tsconfig includes .ts, .tsx and .mts, and no .js). They cost
    // nothing and are already right if `no-undef` is ever switched on.
    files: ["public/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        self: "readonly",
        atob: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Uint8Array: "readonly",
        JSON: "readonly",
      },
    },
  },
]);

export default eslintConfig;
