#!/usr/bin/env node
// scripts/verify-checksums.mjs <SHA256SUMS> <file>
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [sumsPath, filePath] = process.argv.slice(2);
if (!sumsPath || !filePath) throw new Error("usage: verify-checksums.mjs <SHA256SUMS> <file>");
const name = path.basename(filePath);
const lines = (await readFile(sumsPath, "utf8")).split("\n").filter((line) => line.length > 0);
const matches = lines.map((line) => /^([0-9a-f]{64})  (\S+)$/.exec(line));
if (matches.some((match) => match === null)) throw new Error("SHA256SUMS contains a malformed line");
const entries = matches.filter((match) => match[2] === name);
if (entries.length !== 1) throw new Error(`SHA256SUMS must name ${name} exactly once`);
const hash = createHash("sha256");
for await (const chunk of createReadStream(filePath)) hash.update(chunk);
const actual = hash.digest("hex");
if (actual !== entries[0][1]) throw new Error(`${name} does not match its SHA256SUMS line`);
process.stdout.write(`${actual}\n`);
