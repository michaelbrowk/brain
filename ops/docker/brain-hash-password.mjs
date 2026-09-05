#!/usr/bin/env node
// `docker run --rm -i ghcr.io/michaelbrowk/brain:<tag> hash-password`
// reads the login password on stdin and prints its bcrypt hash. The install
// script uses it so the hash comes from the same bcryptjs the app verifies
// with, not from an htpasswd in some other image.
import { createRequire } from "node:module";

// In the image this script lives in /opt/brain/bin/, a sibling of the release
// tree, so bcryptjs is found next to /opt/brain/current/server.js when it is
// not installed next to the script (the repo checkout, where the test runs).
let bcrypt;
try {
  bcrypt = createRequire(import.meta.url)("bcryptjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  bcrypt = createRequire("/opt/brain/current/server.js")("bcryptjs");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (password.trim().length === 0) {
  process.stderr.write("hash-password: read the password on stdin, nothing arrived\n");
  process.exit(2);
}
process.stdout.write(`${bcrypt.hashSync(password, 12)}\n`);
