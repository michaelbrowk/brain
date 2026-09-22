#!/usr/bin/env node
/** SPLICE THE TESTED MODULE INTO THE ENTRY.
 *
 *  An app is one file, and an agent building one in the wild writes one file.
 *  This repo's copy keeps the vocabulary reader in `vocabulary.js` so it can
 *  be unit-tested, and this script copies it into `index.html` between the
 *  two markers, with the `export ` keywords stripped because a classic script
 *  has no exports. `entry.test.ts` asserts the entry still contains the
 *  module's current text, so running this is not optional: skip it and the
 *  gate says so.
 *
 *  Run it by hand whenever `vocabulary.js` changes:
 *
 *      node examples/apps/spanish-trainer/build.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const START = "// --- vocabulary.js ---";
const END = "// --- end vocabulary.js ---";

const source = readFileSync(path.join(dir, "vocabulary.js"), "utf8")
  .replace(/^export /gm, "")
  .trim();

const entryPath = path.join(dir, "index.html");
const entry = readFileSync(entryPath, "utf8");
const from = entry.indexOf(START);
const to = entry.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(`index.html has no ${START} / ${END} pair to splice into`);
  process.exit(1);
}

const next = `${entry.slice(0, from + START.length)}\n${source}\n${entry.slice(to)}`;
if (next === entry) {
  console.log("index.html already carries the current vocabulary.js");
  process.exit(0);
}
writeFileSync(entryPath, next);
console.log("index.html now carries the current vocabulary.js");
