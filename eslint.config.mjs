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
]);

export default eslintConfig;
