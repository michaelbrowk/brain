// Runs every editor round-trip harness and fails if any loses fidelity.
// The .md files are the source of truth, so a serializer regression is the
// scariest bug in the app — this is the gate that catches it.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const harnesses = readdirSync(dir)
  .filter((f) => /^verify-.*-roundtrip\.mjs$/.test(f))
  .sort();
// serialization idempotency guards rev stability (fixed-point serializer) —
// same gate, different invariant than per-block fidelity
harnesses.push("verify-serialize-idempotent.mjs");

let failed = 0;
for (const h of harnesses) {
  const r = spawnSync("node", [path.join(dir, h)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = out.match(/Summary:\s*(.+)$/m);
  const ok = r.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${h}${summary ? `  (${summary[1]})` : ""}`);
  if (!ok) {
    failed++;
    if (!summary) console.log(out.trim().split("\n").slice(-4).join("\n"));
  }
}

console.log(`\n${harnesses.length - failed}/${harnesses.length} harnesses passed`);
process.exit(failed ? 1 : 0);
