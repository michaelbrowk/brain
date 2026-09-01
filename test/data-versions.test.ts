// Every fixture set captured under test/data-versions/<version>/ must open
// with the code at HEAD. A red run here means a schema bump shipped without
// its forward migration (or rebuild path); capture new sets with
// BRAIN_DATA_VERSION_CAPTURE=<version> pnpm data-versions:capture.
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  destroyStoredGmailCredential,
  openGmailTokenEnvelope,
} from "@/lib/mail/providers/gmail/token-envelope";
import { SqliteMailAccountStore } from "@/lib/mail/service/account-store";
import { AtomicMailBlobStore } from "@/lib/mail/service/content-blob-store";
import { SqliteMailContentCache } from "@/lib/mail/service/content-cache";
import { SqliteMailMessageCache } from "@/lib/mail/service/message-cache";
import { SqliteMailSendStore } from "@/lib/mail/service/outbound-store";
import { OAuthStateStore } from "@/lib/oauth/state";
import {
  FIXTURE_ROOT,
  listFixtureVersions,
  VERSIONED_STORES,
} from "../scripts/data-versions.mjs";
import { ACCOUNT_ID, FIXTURE_KEY, HISTORY_ID, TOKEN_BINDING } from "./data-versions/fixtures";

interface FixtureManifest {
  readonly schema: number;
  readonly version: string;
  readonly capturedCommit: string;
  readonly clientId: string;
  readonly stores: Record<string, { schemaVersion: number; path: string }>;
}

const roots: string[] = [];
const versions = await listFixtureVersions(process.cwd());

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** The stores demand 0o700/0o600 ownership; git does not preserve modes. */
async function privateCopy(source: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-data-version-"));
  roots.push(root);
  const target = path.join(root, path.basename(source));
  await cp(source, target, { recursive: true });
  await chmod(target, 0o700);
  const entries = await readdir(target, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    await chmod(
      path.join(entry.parentPath, entry.name),
      entry.isDirectory() ? 0o700 : 0o600,
    );
  }
  return target;
}

function userVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get();
    return row?.user_version as number;
  } finally {
    database.close();
  }
}

describe("data versions", () => {
  it("has at least one captured fixture set", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const version of versions) {
    describe(`fixtures written by ${version}`, () => {
      const directory = path.join(process.cwd(), FIXTURE_ROOT, version);
      const manifest = JSON.parse(
        readFileSync(path.join(directory, "manifest.json"), "utf8"),
      ) as FixtureManifest;

      it("covers every versioned store", () => {
        expect(manifest.schema).toBe(1);
        expect(manifest.version).toBe(version);
        expect(manifest.capturedCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(Object.keys(manifest.stores).sort()).toEqual(
          [...VERSIONED_STORES].sort(),
        );
      });

      it("opens the mail state directory with HEAD and migrates forward", async () => {
        const stateDirectory = await privateCopy(path.join(directory, "mail-state"));
        const credentialPath = path.join(path.dirname(stateDirectory), "wrapping.key");
        await writeFile(credentialPath, FIXTURE_KEY, { mode: 0o600 });
        const accounts = new SqliteMailAccountStore({ stateDirectory, credentialPath });
        await accounts.initialize();
        const listed = await accounts.listAccounts();
        expect(listed.map((stored) => stored.account.accountId)).toEqual([ACCOUNT_ID]);
        accounts.close();
        expect(
          userVersion(path.join(stateDirectory, "local.sqlite3")),
        ).toBeGreaterThanOrEqual(manifest.stores["account-store"]!.schemaVersion);

        const cacheRoot = path.join(stateDirectory, "cache");
        const messages = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
        await messages.initialize();
        expect(messages.readSyncState().historyId).toBe(HISTORY_ID);
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
        expect(
          userVersion(path.join(cacheRoot, ACCOUNT_ID, "messages.sqlite3")),
        ).toBeGreaterThanOrEqual(manifest.stores["message-cache"]!.schemaVersion);

        const outbox = new SqliteMailSendStore({ cacheRoot });
        await outbox.initialize();
        expect(await outbox.countActive()).toBe(1);
        await outbox.close();
        expect(
          userVersion(path.join(cacheRoot, ACCOUNT_ID, "outbox.sqlite3")),
        ).toBeGreaterThanOrEqual(manifest.stores["outbound-store"]!.schemaVersion);
      });

      it("opens the sealed Gmail token envelope", async () => {
        const envelope = JSON.parse(
          await readFile(
            path.join(directory, manifest.stores["token-envelope"]!.path),
            "utf8",
          ),
        ) as unknown;
        const opened = openGmailTokenEnvelope(envelope, FIXTURE_KEY, TOKEN_BINDING);
        expect(opened.emailAddress).toBe("person@gmail.com");
        expect(opened.refreshToken.toString("utf8")).toBe("test-refresh-token");
        destroyStoredGmailCredential(opened);
      });

      it("opens the OAuth state directory and keeps the registered client", async () => {
        const stateDirectory = await privateCopy(path.join(directory, "oauth-state"));
        const store = new OAuthStateStore(stateDirectory);
        await store.readiness();
        expect(await store.getClient(manifest.clientId)).not.toBeNull();
      });
    });
  }
});
