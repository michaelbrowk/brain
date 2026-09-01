import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

const [archive, manifestPath, expectedCommit] = process.argv.slice(2);

if (!archive || !manifestPath || !/^[0-9a-f]{40}$/.test(expectedCommit ?? "")) {
  throw new Error(
    "usage: verify-release-artifact.mjs <archive> <manifest> <40-char-commit>",
  );
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schema !== 1 ||
  manifest.commit !== expectedCommit ||
  manifest.platform !== "linux" ||
  manifest.arch !== "x64" ||
  typeof manifest.builtAt !== "string" ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.builtAt) ||
  typeof manifest.sha256 !== "string" ||
  !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
  !Number.isSafeInteger(manifest.bytes) ||
  manifest.bytes < 1
) {
  throw new Error("release artifact manifest is invalid");
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const actualHash = Buffer.from(hash.digest("hex"), "ascii");
const expectedHash = Buffer.from(manifest.sha256, "ascii");
const { size } = await stat(archive);

if (
  size !== manifest.bytes ||
  actualHash.length !== expectedHash.length ||
  !timingSafeEqual(actualHash, expectedHash)
) {
  throw new Error("release artifact checksum does not match its manifest");
}

process.stdout.write(manifest.builtAt);
