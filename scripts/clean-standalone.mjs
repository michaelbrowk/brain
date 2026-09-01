import { rm } from "node:fs/promises";

// `next build` can preserve files left in an older standalone directory. A
// release must never inherit source, Git metadata, or routes from a prior build.
await rm(new URL("../.next/standalone", import.meta.url), {
  recursive: true,
  force: true,
});
