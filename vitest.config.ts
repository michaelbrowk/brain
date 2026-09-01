import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // `.next-*` is the same build tree under the name BRAIN_DIST_DIR gave it.
    // git, Tailwind and eslint already ignore the shape rather than the one
    // name. Without this, a build under a custom dist dir copies the worker's
    // own tests into the standalone output and the next `pnpm check` runs them
    // outside the workspace that owns them.
    exclude: ["e2e/**", "workers/**", "node_modules/**", ".next/**", ".next-*/**"],
  },
});
