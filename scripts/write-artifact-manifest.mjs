import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";

const [archive, destination, commit, builtAt] = process.argv.slice(2);

if (!archive || !destination || !/^[0-9a-f]{40}$/.test(commit ?? "") || !builtAt) {
  throw new Error(
    "usage: write-artifact-manifest.mjs <archive> <destination> <40-char-commit> <built-at>",
  );
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const { size } = await stat(archive);

await writeFile(
  destination,
  `${JSON.stringify(
    {
      schema: 1,
      commit,
      builtAt,
      platform: "linux",
      arch: "x64",
      sha256: hash.digest("hex"),
      bytes: size,
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o444 },
);
