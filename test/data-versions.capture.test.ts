// Captures one immutable fixture set from HEAD under
// test/data-versions/<version>/. Active only with
// BRAIN_DATA_VERSION_CAPTURE=<version>; refuses to overwrite an existing
// version directory. Run via `pnpm data-versions:capture`.
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { sealGmailTokenEnvelope } from "@/lib/mail/providers/gmail/token-envelope";
import {
  createMailCacheRoot,
  SqliteMailAccountStore,
} from "@/lib/mail/service/account-store";
import { AtomicMailBlobStore } from "@/lib/mail/service/content-blob-store";
import { SqliteMailContentCache } from "@/lib/mail/service/content-cache";
import { SqliteMailMessageCache } from "@/lib/mail/service/message-cache";
import { SqliteMailSendStore } from "@/lib/mail/service/outbound-store";
import { OAuthStateStore } from "@/lib/oauth/state";
import { FIXTURE_ROOT } from "../scripts/data-versions.mjs";
import { parseSemver } from "../scripts/release-version.mjs";
import {
  ACCOUNT_ID,
  FIXTURE_KEY,
  gmailGrantFixture,
  HISTORY_ID,
  imapAccountFixture,
  submissionFixture,
  threadFixture,
  TOKEN_BINDING,
} from "./data-versions/fixtures";

const execFileAsync = promisify(execFile);
const version = process.env.BRAIN_DATA_VERSION_CAPTURE;

describe.skipIf(!version)("data version capture", () => {
  it(`writes the ${version ?? "requested"} fixture set from HEAD`, async () => {
    parseSemver(version!);
    const destination = path.join(process.cwd(), FIXTURE_ROOT, version!);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const work = await mkdtemp(path.join(tmpdir(), "brain-capture-"));
    const stateDirectory = path.join(work, "mail-state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const credentialPath = path.join(work, "wrapping.key");
    await writeFile(credentialPath, FIXTURE_KEY, { mode: 0o600 });

    const accounts = new SqliteMailAccountStore({ stateDirectory, credentialPath });
    await accounts.initialize();
    await accounts.save(
      imapAccountFixture(),
      Buffer.from("fixture-password"),
      new AbortController().signal,
    );
    const accountSchemaVersion = accounts.localSchemaVersion;
    accounts.close();

    const cacheRoot = await createMailCacheRoot(stateDirectory);
    const messages = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
    await messages.initialize();
    const generation = messages.beginInitial(HISTORY_ID);
    messages.putInitialPage(generation, [threadFixture()], null, null);
    messages.completeInitial(generation, 1_500);
    const blobs = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
    await blobs.initialize();
    const content = new SqliteMailContentCache({
      cacheRoot,
      accountId: ACCOUNT_ID,
      blobStore: blobs,
    });
    await content.initialize();
    await content.close();
    await blobs.close();
    messages.close();
    const outbox = new SqliteMailSendStore({ cacheRoot });
    await outbox.initialize();
    await outbox.enqueue(submissionFixture());
    await outbox.close();

    const envelope = sealGmailTokenEnvelope(gmailGrantFixture(), FIXTURE_KEY, TOKEN_BINDING);

    const oauthDirectory = path.join(work, "oauth-state");
    const oauth = new OAuthStateStore(oauthDirectory);
    const client = await oauth.registerClient({
      name: "Fixture client",
      redirectUris: ["https://client.example/callback"],
      applicationType: "web",
      now: 1_800_000_000_000,
    });

    await mkdir(destination, { recursive: true });
    await cp(stateDirectory, path.join(destination, "mail-state"), { recursive: true });
    await cp(oauthDirectory, path.join(destination, "oauth-state"), { recursive: true });
    await writeFile(
      path.join(destination, "gmail-token-envelope.json"),
      `${JSON.stringify(envelope, null, 2)}\n`,
    );
    // Process-local runtime state is not durable data: SQLite WAL strays, the
    // blob-store mutation lease, and the capturing process's OAuth owner claim.
    for (const stray of [
      "local.sqlite3-wal",
      "local.sqlite3-shm",
      ".content-blobs.lock.sqlite3",
      ".content-blobs.lock.sqlite3-wal",
      ".content-blobs.lock.sqlite3-shm",
    ]) {
      await rm(path.join(destination, "mail-state", stray), { force: true });
    }
    for (const entry of await readdir(path.join(destination, "oauth-state"))) {
      if (entry.startsWith("process-owner-")) {
        await rm(path.join(destination, "oauth-state", entry), { force: true });
      }
    }
    const { stdout: capturedCommit } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: process.cwd() },
    );
    const messagesPath = `mail-state/cache/${ACCOUNT_ID}/messages.sqlite3`;
    await writeFile(
      path.join(destination, "manifest.json"),
      `${JSON.stringify(
        {
          schema: 1,
          version,
          capturedCommit: capturedCommit.trim(),
          clientId: client.id,
          stores: {
            "account-store": {
              schemaVersion: accountSchemaVersion,
              path: "mail-state/local.sqlite3",
            },
            "message-cache": { schemaVersion: 1, path: messagesPath },
            "content-cache": { schemaVersion: 1, path: messagesPath },
            "outbound-store": {
              schemaVersion: 2,
              path: `mail-state/cache/${ACCOUNT_ID}/outbox.sqlite3`,
            },
            "token-envelope": { schemaVersion: 1, path: "gmail-token-envelope.json" },
            "oauth-state": { schemaVersion: 2, path: "oauth-state" },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect((await readdir(destination)).sort()).toEqual([
      "gmail-token-envelope.json",
      "mail-state",
      "manifest.json",
      "oauth-state",
    ]);
    await rm(work, { recursive: true, force: true });
  });
});
