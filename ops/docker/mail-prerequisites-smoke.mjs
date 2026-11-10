// Fed to `docker compose exec -T mail node --input-type=module` by the image
// smoke. No manual key preparation: use the key the real bootstrap created,
// and the real networkless worker through its shared Unix socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const runtime = "/opt/brain/current/mail-service";
const require = createRequire(path.join(runtime, "service/account-store.js"));
const { SqliteMailAccountStore } = require(path.join(runtime, "service/account-store.js"));
const { UnixSocketMailMimeParser } = require(path.join(runtime, "service/mime-parser-client.js"));
const scratch = await mkdtemp("/tmp/brain-compose-mail-");
const store = new SqliteMailAccountStore({ stateDirectory: scratch, credentialPath: "/run/credentials/brain-mail/account-wrapping-key" });
const password = Buffer.from("synthetic-compose-password");
try {
  await store.initialize();
  const account = {
    providerKind: "imap", displayName: null, status: "connected", createdAt: 1, updatedAt: 1,
    account: {
      accountId: "account-a11111111111111111111111111111111", emailAddress: "fixture@example.test",
      endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" }, username: "fixture@example.test",
      credentialRef: { id: "credential-r11111111111111111111111111111111", version: 1 },
      transportBindingRef: { id: "binding-r11111111111111111111111111111111", version: 1 }, connectedAt: 1,
    },
  };
  await store.save(account, password, new AbortController().signal);
  const loaded = await store.loadProvisionedAccount(account.account.accountId);
  assert(loaded); assert(loaded.password.equals(password)); loaded.password.fill(0);

  const raw = Buffer.from([
    "From: fixture@example.test", 'Content-Type: multipart/mixed; boundary="compose"', "",
    "--compose", "Content-Type: text/plain; charset=utf-8", "", "Compose body evidence",
    "--compose", "Content-Type: text/plain", 'Content-Disposition: attachment; filename="hello.txt"',
    "Content-Transfer-Encoding: base64", "", Buffer.from("Compose attachment evidence").toString("base64"), "--compose--", "",
  ].join("\r\n"));
  const parser = new UnixSocketMailMimeParser();
  // A second parse proves a connection did not consume the only worker.
  for (let i = 0; i < 2; i++) {
    const result = await parser.parse({
      operationId: `compose-smoke-${i}`,
      rawMime: { sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length },
      budget: { deadlineAt: Date.now() + 10_000, maxRawBytes: 1048576, maxDecodedBytes: 2097152, maxHeaderBytes: 16384, maxHtmlCharacters: 131072, maxTextCharacters: 131072, maxAddresses: 20, maxParts: 32, maxDepth: 8, maxDomNodes: 2000, maxDomAttributes: 4000, maxInlineImagePixels: 1000000, maxInlineImageFrames: 10, maxRemoteImages: 32 },
      rawMimeStream: (async function* () { yield raw; })(), signal: new AbortController().signal,
    });
    assert.equal(result.kind, "parsed", JSON.stringify(result));
    assert(result.artifacts.text.data.toString().includes("Compose body evidence"));
    assert.equal(result.artifacts.attachments[0].blob.data.toString(), "Compose attachment evidence");
  }
  console.log("compose mail credentials, body and attachment smoke passed");
} finally {
  password.fill(0); store.close(); await rm(scratch, { recursive: true, force: true });
}
