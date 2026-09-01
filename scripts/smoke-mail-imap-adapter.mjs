import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapterPath = process.env.BRAIN_MAIL_ADAPTER_PATH;
const rawPort = process.env.BRAIN_MAIL_FAKE_IMAP_PORT;
assert.equal(typeof adapterPath, "string");
assert.match(rawPort ?? "", /^[1-9][0-9]{0,4}$/);
const port = Number(rawPort);
assert.equal(port <= 65_535, true);

const { ImapFlowCredentialVerifier } = require(adapterPath);
const now = Date.now();
const target = Object.freeze({
  protocol: "imap",
  hostname: "localhost",
  port,
  tls: "implicit",
  address: "127.0.0.1",
  family: 4,
  resolutionId: "dns-projected-fake-imap",
  resolvedAt: now,
  expiresAt: now + 5_000,
});
const verifier = new ImapFlowCredentialVerifier({
  dns: { resolve: async () => [target] },
});
await verifier.verify({
  endpoint: { hostname: "localhost", port, tls: "implicit" },
  username: "person@example.test",
  password: Buffer.from("test-only-password"),
  deadlineAt: now + 5_000,
  signal: new AbortController().signal,
});
process.stdout.write("brain-mail projected fake IMAP passed\n");
