#!/usr/bin/env node
/**
 * The memory probe as one file the release can carry.
 *
 * The probe measures the service's own modules, so it has to be built from the
 * repository — but the droplet has no repository, only the release artifact.
 * This bundles it into `.next/standalone/mail-outbox-memory-probe.mjs`, which
 * `scripts/build-release.mjs` ships as `bin/mail-outbox-memory-probe.mjs`, so
 * the reading can be taken against the memory contract that actually applies,
 * on the machine it applies to:
 *
 *   node /opt/brain/current/bin/mail-outbox-memory-probe.mjs --size 8
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

export const PROBE_ENTRY = path.join(
  "scripts",
  "lib",
  "mail-outbox-memory-probe.ts",
);
export const PROBE_BUNDLE_NAME = "mail-outbox-memory-probe.mjs";

/** The bundled probe as text, so a caller can put it where it needs it. */
export async function bundleMailOutboxProbe(root) {
  const bundled = await build({
    entryPoints: [path.join(root, PROBE_ENTRY)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    legalComments: "none",
    logLevel: "warning",
  });
  const output = bundled.outputFiles[0];
  if (!output) throw new Error("the probe bundle produced no output");
  return output.text;
}

async function main() {
  const root = process.cwd();
  const output = path.join(root, ".next", "standalone");
  await mkdir(output, { recursive: true });
  const file = path.join(output, PROBE_BUNDLE_NAME);
  await writeFile(file, await bundleMailOutboxProbe(root), { mode: 0o644 });
  process.stdout.write(`${path.relative(root, file)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
