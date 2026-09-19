#!/usr/bin/env node
/**
 * The memory probe, from a working tree.
 *
 *   node scripts/mail-outbox-memory-probe.mjs --size 8
 *
 * Bundles `scripts/lib/mail-outbox-memory-probe.ts` — the probe itself, with
 * the service's own modules inside it rather than a copy of them — and runs it.
 * The same bundle is what `pnpm build:probe` writes into the release, so the
 * droplet takes the same reading with plain `node` and no dependencies.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { bundleMailOutboxProbe } from "./build-probe.mjs";

const workspace = mkdtempSync(path.join(tmpdir(), "brain-outbox-probe-bundle-"));
const bundle = path.join(workspace, "mail-outbox-memory-probe.mjs");
try {
  writeFileSync(bundle, await bundleMailOutboxProbe(process.cwd()), {
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [bundle, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
