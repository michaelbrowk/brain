import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { isSafeGmailCredentialMetadata } from "../providers/gmail/credentials";
import {
  GMAIL_OAUTH_SCOPES,
  type GmailOAuthGrant,
} from "../providers/gmail/oauth";
import { destroyStoredGmailCredential } from "../providers/gmail/token-envelope";

import {
  createMailCacheRoot,
  EncryptedFileMailAccountStore,
  SqliteMailAccountStore,
} from "./account-store";
import {
  MailAccountError,
  type StoredImapMailAccount,
} from "./account-types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("encrypted one-account store", () => {
  it("encrypts the entire exact payload and authenticates it on public reads", async () => {
    const fixture = await createStore();
    const controller = new AbortController();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      controller.signal,
    );

    const raw = await readFile(path.join(fixture.stateDirectory, "account.v1.json"), "utf8");
    for (const secretOrMetadata of [
      "test-only-password",
      "person@example.test",
      "imap.example.test",
      "credential-r22222222222222222222222222222222",
    ]) {
      expect(raw).not.toContain(secretOrMetadata);
    }
    expect(Object.keys(JSON.parse(raw))).toEqual(["schemaVersion", "encryption"]);

    expect(await fixture.store.readAccount()).toEqual(accountFixture());
    const loaded = await fixture.store.loadProvisionedAccount();
    expect(loaded?.password.toString("utf8")).toBe("test-only-password");
    loaded?.password.fill(0);

    const envelope = JSON.parse(raw) as {
      encryption: { ciphertext: string };
    };
    const first = envelope.encryption.ciphertext[0];
    envelope.encryption.ciphertext = `${first === "A" ? "B" : "A"}${envelope.encryption.ciphertext.slice(1)}`;
    await writeFile(
      path.join(fixture.stateDirectory, "account.v1.json"),
      `${JSON.stringify(envelope)}\n`,
      { mode: 0o600 },
    );
    await expect(fixture.store.readAccount()).rejects.toMatchObject({
      code: "account_state_invalid",
    });
  });

  it("does not commit when the request aborts before the atomic rename", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("old-test-password"),
      new AbortController().signal,
    );
    const controller = new AbortController();
    const abortingStore = new EncryptedFileMailAccountStore({
      stateDirectory: fixture.stateDirectory,
      credentialPath: fixture.credentialPath,
      beforeCommit: () => controller.abort(),
    });
    await expect(
      abortingStore.save(
        { ...accountFixture(), emailAddress: "new@example.test" },
        Buffer.from("new-test-password"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(await fixture.store.readAccount()).toEqual(accountFixture());
    const loaded = await fixture.store.loadProvisionedAccount();
    expect(loaded?.password.toString("utf8")).toBe("old-test-password");
    loaded?.password.fill(0);
  });

  it("finishes the committed save when abort arrives after atomic rename", async () => {
    const fixture = await createStore();
    const controller = new AbortController();
    const committingStore = new EncryptedFileMailAccountStore({
      stateDirectory: fixture.stateDirectory,
      credentialPath: fixture.credentialPath,
      afterCommit: () => controller.abort(),
    });

    await expect(
      committingStore.save(
        accountFixture(),
        Buffer.from("test-only-password"),
        controller.signal,
      ),
    ).resolves.toBeUndefined();
    await expect(fixture.store.readAccount()).resolves.toEqual(accountFixture());
  });

  it("disconnects locally even with a lost key and purges the entire cache", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      new AbortController().signal,
    );
    const cache = await createMailCacheRoot(fixture.stateDirectory);
    const outside = path.join(fixture.root, "outside.txt");
    await writeFile(outside, "keep", { mode: 0o600 });
    await writeFile(path.join(cache, "message.cache"), "cached", { mode: 0o600 });
    await symlink(outside, path.join(cache, "external-link"));
    await unlink(fixture.credentialPath);

    await expect(fixture.store.disconnect()).resolves.toBe(true);
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(cache, "message.cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fixture.store.disconnect()).resolves.toBe(false);
    await fixture.store.recoverInterruptedCleanup();
    await expect(readFile(path.join(fixture.stateDirectory, "account.v1.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(
      (await readdir(fixture.stateDirectory)).filter((entry) =>
        entry.startsWith(".deleting-cache-"),
      ),
    ).toEqual([]);
  });

  it("removes strict stale save files on disconnect and startup recovery", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      new AbortController().signal,
    );
    const activeCache = await createMailCacheRoot(fixture.stateDirectory);
    await writeFile(path.join(activeCache, "active.cache"), "keep", { mode: 0o600 });
    const stagedCache = path.join(
      fixture.stateDirectory,
      ".deleting-cache-111111111111111111111111",
    );
    await mkdir(stagedCache, { mode: 0o700 });
    await writeFile(path.join(stagedCache, "stale.cache"), "remove", { mode: 0o600 });
    const staleTemp = path.join(
      fixture.stateDirectory,
      ".account.v1.999.222222222222222222222222.tmp",
    );
    await writeFile(staleTemp, "encrypted-stale", { mode: 0o600 });

    await fixture.store.recoverInterruptedCleanup();
    await expect(readFile(staleTemp)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(stagedCache, "stale.cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(activeCache, "active.cache"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(fixture.store.readAccount()).resolves.toEqual(accountFixture());

    const secondTemp = path.join(
      fixture.stateDirectory,
      ".account.v1.1000.333333333333333333333333.tmp",
    );
    await writeFile(secondTemp, "encrypted-stale", { mode: 0o600 });
    await expect(fixture.store.disconnect()).resolves.toBe(true);
    await expect(readFile(secondTemp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symlinked and hardlinked stale save files before deleting state", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const fixture = await createStore();
      await fixture.store.save(
        accountFixture(),
        Buffer.from("test-only-password"),
        new AbortController().signal,
      );
      const outside = path.join(fixture.root, `${kind}-outside`);
      await writeFile(outside, "keep", { mode: 0o600 });
      const staleTemp = path.join(
        fixture.stateDirectory,
        `.account.v1.999.${(kind === "symlink" ? "4" : "5").repeat(24)}.tmp`,
      );
      if (kind === "symlink") {
        await symlink(outside, staleTemp);
      } else {
        await link(outside, staleTemp);
      }

      await expect(fixture.store.disconnect()).rejects.toBeInstanceOf(
        MailAccountError,
      );
      await expect(readFile(outside, "utf8")).resolves.toBe("keep");
      await expect(fixture.store.readAccount()).resolves.toEqual(accountFixture());
    }
  });

  it("refuses a symlinked cache root and preserves the credential for retry", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      new AbortController().signal,
    );
    const outside = path.join(fixture.root, "outside-cache");
    await writeFile(outside, "keep", { mode: 0o600 });
    await symlink(outside, path.join(fixture.stateDirectory, "cache"));

    await expect(fixture.store.disconnect()).rejects.toMatchObject({
      code: "account_state_unavailable",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
    await expect(fixture.store.readAccount()).resolves.toEqual(accountFixture());
  });

  it("rejects a wrapping key with unsafe permissions", async () => {
    const fixture = await createStore();
    await chmod(fixture.credentialPath, 0o644);
    await expect(
      fixture.store.save(
        accountFixture(),
        Buffer.from("test-only-password"),
        new AbortController().signal,
      ),
    ).rejects.toEqual(new MailAccountError("credential_key_invalid"));
  });

  it("accepts a read-only owner wrapping key", async () => {
    const fixture = await createStore();
    await chmod(fixture.credentialPath, 0o400);
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      new AbortController().signal,
    );
    expect(await fixture.store.readAccount()).toEqual(accountFixture());
  });

  it.skipIf(process.geteuid?.() === 0)(
    "rejects a group-readable wrapping key owned by the service user",
    async () => {
      const fixture = await createStore();
      await chmod(fixture.credentialPath, 0o440);
      await expect(
        fixture.store.save(
          accountFixture(),
          Buffer.from("test-only-password"),
          new AbortController().signal,
        ),
      ).rejects.toEqual(new MailAccountError("credential_key_invalid"));
    },
  );

  it("rejects hardlinked, symlinked, and oversized state files", async () => {
    const fixture = await createStore();
    const statePath = path.join(fixture.stateDirectory, "account.v1.json");
    await fixture.store.save(
      accountFixture(),
      Buffer.from("test-only-password"),
      new AbortController().signal,
    );
    const hardlinkPath = path.join(fixture.stateDirectory, "linked-state");
    await link(statePath, hardlinkPath);
    await expect(fixture.store.readAccount()).rejects.toMatchObject({
      code: "account_state_invalid",
    });
    await unlink(hardlinkPath);
    await unlink(statePath);

    const outside = path.join(fixture.root, "outside-state");
    await writeFile(outside, "{}", { mode: 0o600 });
    await symlink(outside, statePath);
    await expect(fixture.store.readAccount()).rejects.toMatchObject({
      code: "account_state_unavailable",
    });
    await unlink(statePath);

    await writeFile(statePath, "x".repeat(33 * 1024), { mode: 0o600 });
    await expect(fixture.store.readAccount()).rejects.toMatchObject({
      code: "account_state_invalid",
    });
  });
});

describe("SQLite multi-account store", () => {
  it("migrates the encrypted bootstrap exactly once and keeps its identity", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("legacy-test-password"),
      new AbortController().signal,
    );
    const cache = await createMailCacheRoot(fixture.stateDirectory);
    await writeFile(path.join(cache, "legacy.cache"), "cached", { mode: 0o600 });

    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    expect(await store.listAccounts()).toEqual([storedLegacyFixture()]);
    const migratedDatabase = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(
      migratedDatabase
        .prepare(
          "SELECT provider_kind, gmail_subject FROM accounts WHERE account_id = ?",
        )
        .get(accountFixture().accountId),
    ).toEqual({ provider_kind: "imap", gmail_subject: null });
    migratedDatabase.close();
    const loaded = await store.loadProvisionedAccount(
      accountFixture().accountId,
    );
    expect(loaded?.password.toString("utf8")).toBe("legacy-test-password");
    loaded?.password.fill(0);
    await expect(
      readFile(path.join(fixture.stateDirectory, "account.v1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(fixture.stateDirectory, "account.v1.migrated.json")),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      readFile(
        path.join(
          fixture.stateDirectory,
          "cache",
          accountFixture().accountId,
          "legacy.cache",
        ),
        "utf8",
      ),
    ).resolves.toBe("cached");
    const databaseBytes = await readFile(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(databaseBytes.includes(Buffer.from("legacy-test-password"))).toBe(false);
    store.close();

    const reopened = new SqliteMailAccountStore(fixture);
    await reopened.initialize();
    expect(await reopened.listAccounts()).toEqual([storedLegacyFixture()]);
    await expect(
      reopened.deleteAccount(accountFixture().accountId),
    ).resolves.toBe(true);
    await expect(
      readFile(path.join(fixture.stateDirectory, "account.v1.migrated.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    reopened.close();
  });

  it("enforces three accounts and normalized provider-email uniqueness", async () => {
    const fixture = await createStore();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    for (let index = 1; index <= 3; index += 1) {
      await store.save(
        storedFixture(index),
        Buffer.from(`password-${index}`),
        new AbortController().signal,
      );
    }
    await expect(
      store.save(
        storedFixture(4),
        Buffer.from("password-4"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "account_limit_reached" });

    await store.deleteAccount(storedFixture(3).account.accountId);
    await expect(
      store.save(
        {
          ...storedFixture(4),
          account: {
            ...storedFixture(4).account,
            emailAddress: "PERSON@EXAMPLE.TEST",
          },
        },
        Buffer.from("duplicate-password"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    expect(await store.listAccounts()).toHaveLength(2);
    store.close();
  });

  it("keeps receive-only IMAP writes readable by the previous schema-v1 release", async () => {
    const fixture = await createStore();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    const initial = storedFixture();
    const password = Buffer.from("rollback-compatible-test-password");
    await store.save(initial, password, new AbortController().signal);
    const updated = {
      ...initial,
      account: {
        ...initial.account,
        credentialRef: { ...initial.account.credentialRef, version: 2 },
        transportBindingRef: {
          ...initial.account.transportBindingRef,
          version: 2,
        },
      },
      displayName: "Renamed",
      updatedAt: 2,
    };
    await store.save(
      updated,
      password,
      new AbortController().signal,
    );

    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    const row = database
      .prepare("SELECT config_json FROM accounts WHERE account_id = ?")
      .get(initial.account.accountId) as { readonly config_json: string };
    expect(JSON.parse(row.config_json)).toEqual({
      schemaVersion: 1,
      endpoint: updated.account.endpoint,
      username: updated.account.username,
      credentialRefId: updated.account.credentialRef.id,
      transportBindingRefId: updated.account.transportBindingRef.id,
      connectedAt: updated.account.connectedAt,
    });
    expect(row.config_json).not.toContain('"smtp"');
    database.close();
    password.fill(0);
    store.close();
  });

  it("persists redacted SMTP metadata with the shared encrypted password across restart", async () => {
    const fixture = await createStore();
    const stored = storedSmtpFixture();
    const password = Buffer.from("SHARED_MAILBOX_SECRET_MUST_STAY_ENCRYPTED");
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    await store.save(stored, password, new AbortController().signal);
    expect(await store.listAccounts()).toEqual([stored]);
    store.close();

    const databaseBytes = await readFile(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(databaseBytes.includes(password)).toBe(false);
    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    const row = database
      .prepare(
        `SELECT accounts.config_json, meta.value AS smtp_config_json
           FROM accounts
           JOIN meta ON meta.key = 'smtp_account_config:' || accounts.account_id
          WHERE accounts.account_id = ?`,
      )
      .get(stored.account.accountId);
    expect(row).toMatchObject({
      config_json: expect.stringContaining('"schemaVersion":1'),
      smtp_config_json: expect.stringContaining('"schemaVersion":1'),
    });
    expect(JSON.parse((row as { config_json: string }).config_json)).toEqual({
      schemaVersion: 1,
      endpoint: stored.account.endpoint,
      username: stored.account.username,
      credentialRefId: stored.account.credentialRef.id,
      transportBindingRefId: stored.account.transportBindingRef.id,
      connectedAt: stored.account.connectedAt,
    });
    expect((row as { config_json: string }).config_json).not.toContain('"smtp"');
    expect(
      JSON.parse((row as { smtp_config_json: string }).smtp_config_json),
    ).toMatchObject({
      schemaVersion: 1,
      endpoint: stored.account.smtp?.endpoint,
      username: stored.account.smtp?.username,
      status: "connected",
    });
    expect(JSON.stringify(row)).not.toContain("SHARED_MAILBOX_SECRET");
    database.close();

    const reopened = new SqliteMailAccountStore(fixture);
    await reopened.initialize();
    expect(await reopened.listAccounts()).toEqual([stored]);
    const loaded = await reopened.loadProvisionedAccount(stored.account.accountId);
    expect(loaded?.stored).toEqual(stored);
    expect(loaded?.password).toEqual(password);
    loaded?.password.fill(0);
    await expect(
      reopened.deleteAccount(stored.account.accountId),
    ).resolves.toBe(true);
    reopened.close();
    const deletedDatabase = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(
      deletedDatabase
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`smtp_account_config:${stored.account.accountId}`),
    ).toBeUndefined();
    deletedDatabase.close();
    password.fill(0);
  });

  it("persists reauth_required after a definite SMTP authentication failure", async () => {
    const fixture = await createStore();
    const stored = storedSmtpFixture();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    await store.save(
      stored,
      Buffer.from("shared-test-password"),
      new AbortController().signal,
    );

    await store.markAccountReauthRequired(stored.account.accountId);
    await expect(store.readAccount(stored.account.accountId)).resolves.toMatchObject({
      status: "reauth_required",
      account: { smtp: expect.any(Object) },
    });
    await expect(
      store.markAccountReauthRequired(stored.account.accountId),
    ).resolves.toBeUndefined();
    store.close();

    const rollbackDatabase = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    const rollbackRow = rollbackDatabase
      .prepare(
        `SELECT accounts.status, accounts.config_json,
                meta.value AS smtp_config_json
           FROM accounts
           JOIN meta ON meta.key = 'smtp_account_config:' || accounts.account_id
          WHERE accounts.account_id = ?`,
      )
      .get(stored.account.accountId) as {
      readonly status: string;
      readonly config_json: string;
      readonly smtp_config_json: string;
    };
    expect(rollbackRow.status).toBe("connected");
    expect(JSON.parse(rollbackRow.config_json).schemaVersion).toBe(1);
    expect(JSON.parse(rollbackRow.smtp_config_json).status).toBe(
      "reauth_required",
    );
    rollbackDatabase.close();

    const reopened = new SqliteMailAccountStore(fixture);
    await reopened.initialize();
    await expect(
      reopened.readAccount(stored.account.accountId),
    ).resolves.toMatchObject({ status: "reauth_required" });
    reopened.close();
  });

  it("ignores an SMTP sidecar made stale by a previous-release IMAP rotation", async () => {
    const fixture = await createStore();
    const stored = storedSmtpFixture();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    await store.save(
      stored,
      Buffer.from("old-release-rotation-test-password"),
      new AbortController().signal,
    );
    store.close();

    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    database
      .prepare(
        `UPDATE accounts
            SET credential_version = 2, binding_version = 2, updated_at = 2
          WHERE account_id = ?`,
      )
      .run(stored.account.accountId);
    database
      .prepare(
        `UPDATE credentials SET version = 2
          WHERE account_id = ? AND kind = 'password'`,
      )
      .run(stored.account.accountId);
    database.close();

    const reopened = new SqliteMailAccountStore(fixture);
    await reopened.initialize();
    const recovered = await reopened.readAccount(stored.account.accountId);
    expect(recovered).toMatchObject({
      providerKind: "imap",
      status: "connected",
      account: {
        credentialRef: { version: 2 },
        transportBindingRef: { version: 2 },
      },
    });
    expect(recovered?.providerKind === "imap" && recovered.account.smtp).toBe(
      undefined,
    );
    reopened.close();
  });

  it("persists only the encrypted Gmail refresh token and survives restart", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    const grant = gmailGrantFixture({
      accessToken: "ACCESS_TOKEN_MUST_NOT_PERSIST",
      refreshToken: "REFRESH_TOKEN_MUST_BE_ENCRYPTED",
      grantedAt: now,
    });
    await store.persistGrant(grant, null, new AbortController().signal);
    const listed = await store.listAccounts();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      providerKind: "gmail",
      account: {
        emailAddress: "person@gmail.com",
        subject: "google-subject-1",
        credentialRef: { version: 1 },
      },
    });
    const accountId = listed[0].account.accountId;
    const loaded = await store.loadGmailCredential(accountId);
    expect(loaded?.credential.refreshToken.toString("utf8")).toBe(
      "REFRESH_TOKEN_MUST_BE_ENCRYPTED",
    );
    expect(loaded && "accessToken" in loaded.credential).toBe(false);
    if (loaded) destroyStoredGmailCredential(loaded.credential);
    store.close();

    const databaseBytes = await readFile(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(databaseBytes.includes(Buffer.from("ACCESS_TOKEN_MUST_NOT_PERSIST"))).toBe(
      false,
    );
    expect(
      databaseBytes.includes(Buffer.from("REFRESH_TOKEN_MUST_BE_ENCRYPTED")),
    ).toBe(false);
    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    expect(
      database
        .prepare(
          "SELECT gmail_subject FROM accounts WHERE account_id = ?",
        )
        .get(accountId),
    ).toEqual({ gmail_subject: "google-subject-1" });
    expect(
      database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name = 'accounts_gmail_subject_unique'",
        )
        .get(),
    ).toMatchObject({
      sql: expect.stringContaining("WHERE gmail_subject IS NOT NULL"),
    });
    database.close();
    const reopened = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await reopened.initialize();
    expect(await reopened.listAccounts()).toEqual(listed);
    const reopenedCredential = await reopened.loadGmailCredential(accountId);
    expect(reopenedCredential?.credential.refreshToken.toString("utf8")).toBe(
      "REFRESH_TOKEN_MUST_BE_ENCRYPTED",
    );
    if (reopenedCredential) {
      destroyStoredGmailCredential(reopenedCredential.credential);
    }
    reopened.close();
    grant.accessToken.fill(0);
    grant.refreshToken.fill(0);
  });

  it("persists a grant with a read-only owner wrapping key", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    await chmod(fixture.credentialPath, 0o400);
    const grant = gmailGrantFixture({ grantedAt: now });
    await store.persistGrant(grant, null, new AbortController().signal);
    expect(await store.listAccounts()).toHaveLength(1);
    grant.accessToken.fill(0);
    grant.refreshToken.fill(0);
    store.close();
  });

  it.skipIf(process.geteuid?.() === 0)(
    "rejects a grant when the wrapping key is group-readable and owned by the service user",
    async () => {
      const fixture = await createStore();
      const now = 1_800_000_000_000;
      const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
      await store.initialize();
      await chmod(fixture.credentialPath, 0o440);
      const grant = gmailGrantFixture({ grantedAt: now });
      await expect(
        store.persistGrant(grant, null, new AbortController().signal),
      ).rejects.toEqual(new MailAccountError("credential_key_invalid"));
      expect(await store.listAccounts()).toEqual([]);
      grant.accessToken.fill(0);
      grant.refreshToken.fill(0);
      store.close();
    },
  );

  it("accepts the sealed systemd credential shape via the shared predicate", () => {
    expect(
      isSafeGmailCredentialMetadata({ uid: 0, gid: 0, mode: 0o100440 }, 997),
    ).toBe(true);
    expect(
      isSafeGmailCredentialMetadata({ uid: 997, gid: 997, mode: 0o100440 }, 997),
    ).toBe(false);
    expect(
      isSafeGmailCredentialMetadata({ uid: 997, gid: 997, mode: 0o100600 }, 997),
    ).toBe(true);
  });

  it("rejects a second create for the same stable Google subject", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    const firstGrant = gmailGrantFixture({
      emailAddress: "original@gmail.com",
      refreshToken: "original-refresh-token",
      grantedAt: now,
    });
    const duplicateGrant = gmailGrantFixture({
      emailAddress: "renamed@gmail.com",
      refreshToken: "duplicate-refresh-token",
      grantedAt: now,
    });
    await store.persistGrant(firstGrant, null, new AbortController().signal);
    await expect(
      store.persistGrant(duplicateGrant, null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].account.emailAddress).toBe("original@gmail.com");
    const loaded = await store.loadGmailCredential(accounts[0].account.accountId);
    expect(loaded?.credential.refreshToken.toString("utf8")).toBe(
      "original-refresh-token",
    );
    if (loaded) destroyStoredGmailCredential(loaded.credential);
    for (const grant of [firstGrant, duplicateGrant]) {
      grant.accessToken.fill(0);
      grant.refreshToken.fill(0);
    }
    store.close();
  });

  it("enforces one global email namespace and the raw three-account cap", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    for (const index of [1, 2, 3]) {
      await store.save(
        storedFixture(index),
        Buffer.from(`password-${index}`),
        new AbortController().signal,
      );
    }
    const overCap = gmailGrantFixture({
      emailAddress: "fourth@gmail.com",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(overCap, null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "account_limit_reached" });
    await store.deleteAccount(storedFixture(3).account.accountId);
    const duplicate = gmailGrantFixture({
      emailAddress: "PERSON@EXAMPLE.TEST",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(duplicate, null, new AbortController().signal),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    expect(await store.countAccounts()).toBe(2);
    for (const value of [overCap, duplicate]) {
      value.accessToken.fill(0);
      value.refreshToken.fill(0);
    }
    store.close();
  });

  it("reconnects the exact Gmail identity atomically with a later grant", async () => {
    const fixture = await createStore();
    let now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    const firstGrant = gmailGrantFixture({
      refreshToken: "first-refresh-token",
      grantedAt: now,
    });
    await store.persistGrant(firstGrant, null, new AbortController().signal);
    const first = (await store.listAccounts())[0];
    const accountId = first.account.accountId;
    const cacheRoot = await createMailCacheRoot(fixture.stateDirectory);
    const accountCache = path.join(cacheRoot, accountId);
    await mkdir(accountCache, { mode: 0o700 });
    await writeFile(path.join(accountCache, "message.cache"), "cached", {
      mode: 0o600,
    });
    await expect(store.validateReconnectTarget(accountId)).resolves.toBeUndefined();

    now += 60_000;
    const secondGrant = gmailGrantFixture({
      accessToken: "second-access-token",
      refreshToken: "second-refresh-token",
      emailAddress: "renamed@gmail.com",
      grantedAt: now,
    });
    await store.persistGrant(secondGrant, accountId, new AbortController().signal);
    const after = (await store.listAccounts())[0];
    expect(after.account.accountId).toBe(accountId);
    expect(after.createdAt).toBe(first.createdAt);
    expect(after.updatedAt).toBe(now);
    expect(after.account.connectedAt).toBe(now);
    expect(after.account.emailAddress).toBe("renamed@gmail.com");
    expect(after.account.credentialRef.version).toBe(2);
    await expect(
      readFile(path.join(accountCache, "message.cache"), "utf8"),
    ).resolves.toBe("cached");
    const loaded = await store.loadGmailCredential(accountId);
    expect(loaded?.credential.refreshToken.toString("utf8")).toBe(
      "second-refresh-token",
    );
    if (loaded) destroyStoredGmailCredential(loaded.credential);

    const mismatched = gmailGrantFixture({
      subject: "different-google-subject",
      refreshToken: "must-not-commit",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(mismatched, accountId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    expect(await store.listAccounts()).toEqual([after]);
    const unchanged = await store.loadGmailCredential(accountId);
    expect(unchanged?.credential.refreshToken.toString("utf8")).toBe(
      "second-refresh-token",
    );
    if (unchanged) destroyStoredGmailCredential(unchanged.credential);

    await expect(
      store.validateReconnectTarget("account-affffffffffffffffffffffffffffffff"),
    ).rejects.toMatchObject({ code: "account_not_found" });
    const imap = storedFixture(2);
    await store.save(
      imap,
      Buffer.from("imap-password"),
      new AbortController().signal,
    );
    await expect(
      store.validateReconnectTarget(imap.account.accountId),
    ).rejects.toMatchObject({ code: "account_request_invalid" });

    for (const value of [firstGrant, secondGrant, mismatched]) {
      value.accessToken.fill(0);
      value.refreshToken.fill(0);
    }
    store.close();
  });

  it("does not rotate a reconnect token when the renamed email is owned", async () => {
    const fixture = await createStore();
    let now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    const firstGrant = gmailGrantFixture({
      emailAddress: "original@gmail.com",
      refreshToken: "original-refresh-token",
      grantedAt: now,
    });
    await store.persistGrant(firstGrant, null, new AbortController().signal);
    const gmail = (await store.listAccounts())[0];
    const claimed = {
      ...storedFixture(2),
      account: {
        ...storedFixture(2).account,
        emailAddress: "claimed@gmail.com",
      },
    };
    await store.save(
      claimed,
      Buffer.from("claimed-password"),
      new AbortController().signal,
    );

    now += 60_000;
    const collision = gmailGrantFixture({
      emailAddress: "CLAIMED@gmail.com",
      refreshToken: "must-not-commit",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(
        collision,
        gmail.account.accountId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    expect(await store.readAccount(gmail.account.accountId)).toEqual(gmail);
    const unchanged = await store.loadGmailCredential(gmail.account.accountId);
    expect(unchanged?.credential.refreshToken.toString("utf8")).toBe(
      "original-refresh-token",
    );
    if (unchanged) destroyStoredGmailCredential(unchanged.credential);
    for (const grant of [firstGrant, collision]) {
      grant.accessToken.fill(0);
      grant.refreshToken.fill(0);
    }
    store.close();
  });

  it("serializes concurrent creates for one Google subject", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const firstStore = new SqliteMailAccountStore({ ...fixture, now: () => now });
    const secondStore = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await firstStore.initialize();
    await secondStore.initialize();
    const firstGrant = gmailGrantFixture({
      emailAddress: "first@gmail.com",
      refreshToken: "first-refresh-token",
      grantedAt: now,
    });
    const secondGrant = gmailGrantFixture({
      emailAddress: "second@gmail.com",
      refreshToken: "second-refresh-token",
      grantedAt: now,
    });
    const results = await Promise.allSettled([
      firstStore.persistGrant(firstGrant, null, new AbortController().signal),
      secondStore.persistGrant(secondGrant, null, new AbortController().signal),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "account_already_exists" },
    });
    expect(await firstStore.countAccounts()).toBe(1);
    for (const grant of [firstGrant, secondGrant]) {
      grant.accessToken.fill(0);
      grant.refreshToken.fill(0);
    }
    secondStore.close();
    firstStore.close();
  });

  it("rejects a draft-v2 database without the exact Gmail identity index", async () => {
    const fixture = await createStore();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    store.close();
    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    database.exec("DROP INDEX accounts_gmail_subject_unique");
    database.close();

    const reopened = new SqliteMailAccountStore(fixture);
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: "account_state_invalid",
    });
  });

  it("isolates an invalid row while raw capacity and healthy deletion stay exact", async () => {
    const fixture = await createStore();
    const now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({ ...fixture, now: () => now });
    await store.initialize();
    const grant = gmailGrantFixture({ grantedAt: now });
    await store.persistGrant(grant, null, new AbortController().signal);
    const gmail = (await store.listAccounts())[0];
    const imap = storedFixture(2);
    await store.save(
      imap,
      Buffer.from("imap-password"),
      new AbortController().signal,
    );
    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    database
      .prepare("UPDATE accounts SET config_json = ? WHERE account_id = ?")
      .run('{"schemaVersion":99}', gmail.account.accountId);
    database.close();

    expect(await store.countAccounts()).toBe(2);
    expect(await store.listAccounts()).toEqual([imap]);
    await expect(store.deleteAccount(imap.account.accountId)).resolves.toBe(true);
    expect(await store.countAccounts()).toBe(1);
    expect(await store.listAccounts()).toEqual([]);
    grant.accessToken.fill(0);
    grant.refreshToken.fill(0);
    store.close();
  });

  it("deletes only the selected account, credential, and cache", async () => {
    const fixture = await createStore();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    const first = storedFixture(1);
    const second = storedFixture(2);
    await store.save(
      first,
      Buffer.from("first-password"),
      new AbortController().signal,
    );
    await store.save(
      second,
      Buffer.from("second-password"),
      new AbortController().signal,
    );
    const cacheRoot = await createMailCacheRoot(fixture.stateDirectory);
    for (const stored of [first, second]) {
      const accountCache = path.join(cacheRoot, stored.account.accountId);
      await mkdir(accountCache, { mode: 0o700 });
      await writeFile(path.join(accountCache, "message.cache"), "cached", {
        mode: 0o600,
      });
    }

    await expect(store.deleteAccount(first.account.accountId)).resolves.toBe(true);
    await expect(store.readAccount(first.account.accountId)).resolves.toBeNull();
    await expect(
      store.loadProvisionedAccount(first.account.accountId),
    ).resolves.toBeNull();
    await expect(
      readFile(path.join(cacheRoot, first.account.accountId, "message.cache")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.readAccount(second.account.accountId)).resolves.toEqual(
      second,
    );
    const loaded = await store.loadProvisionedAccount(second.account.accountId);
    expect(loaded?.password.toString("utf8")).toBe("second-password");
    loaded?.password.fill(0);
    await expect(
      readFile(path.join(cacheRoot, second.account.accountId, "message.cache"), "utf8"),
    ).resolves.toBe("cached");
    store.close();
  });

  it("keeps every committed mutation truthful when post-commit diagnostics fail", async () => {
    const fixture = await createStore();
    let now = 1_800_000_000_000;
    const store = new SqliteMailAccountStore({
      ...fixture,
      now: () => now,
      afterCommit: () => {
        throw new Error("injected post-commit failure");
      },
    });
    await store.initialize();

    const firstGrant = gmailGrantFixture({
      refreshToken: "first-committed-refresh-token",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(firstGrant, null, new AbortController().signal),
    ).resolves.toBeUndefined();
    const firstGmail = (await store.listAccounts())[0];

    now += 60_000;
    const secondGrant = gmailGrantFixture({
      emailAddress: "renamed@gmail.com",
      refreshToken: "second-committed-refresh-token",
      grantedAt: now,
    });
    await expect(
      store.persistGrant(
        secondGrant,
        firstGmail.account.accountId,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    const reconnected = await store.readAccount(firstGmail.account.accountId);
    expect(reconnected).toMatchObject({
      providerKind: "gmail",
      account: {
        emailAddress: "renamed@gmail.com",
        credentialRef: { version: 2 },
      },
    });

    const imap = storedFixture(2);
    await expect(
      store.save(
        imap,
        Buffer.from("committed-imap-password"),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    const renamedImap = {
      ...imap,
      displayName: "Work",
      updatedAt: imap.updatedAt + 1,
    };
    await expect(
      store.updateMetadata(renamedImap, new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(store.readAccount(imap.account.accountId)).resolves.toEqual(
      renamedImap,
    );
    await expect(store.deleteAccount(imap.account.accountId)).resolves.toBe(true);
    await expect(store.readAccount(imap.account.accountId)).resolves.toBeNull();
    await expect(
      store.deleteAccount(firstGmail.account.accountId),
    ).resolves.toBe(true);
    expect(await store.listAccounts()).toEqual([]);

    for (const grant of [firstGrant, secondGrant]) {
      grant.accessToken.fill(0);
      grant.refreshToken.fill(0);
    }
    store.close();
  });

  it("recovers legacy-envelope cleanup after a committed delete", async () => {
    const fixture = await createStore();
    await fixture.store.save(
      accountFixture(),
      Buffer.from("legacy-test-password"),
      new AbortController().signal,
    );
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    const archive = path.join(
      fixture.stateDirectory,
      "account.v1.migrated.json",
    );
    const blockingHardlink = path.join(
      fixture.stateDirectory,
      "account.v1.migrated.blocking-link",
    );
    await link(archive, blockingHardlink);

    await expect(
      store.deleteAccount(accountFixture().accountId),
    ).resolves.toBe(true);
    expect(await store.listAccounts()).toEqual([]);
    await expect(readFile(archive)).resolves.toBeInstanceOf(Buffer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    store.close();

    await unlink(blockingHardlink);
    const recovered = new SqliteMailAccountStore(fixture);
    await recovered.initialize();
    expect(await recovered.listAccounts()).toEqual([]);
    await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" });
    recovered.close();
  });

  it("does not commit a credential rotation when abort wins before BEGIN", async () => {
    const fixture = await createStore();
    const controller = new AbortController();
    const store = new SqliteMailAccountStore({
      ...fixture,
      beforeCommit: () => controller.abort(),
    });
    await store.initialize();
    await expect(
      store.save(
        storedFixture(),
        Buffer.from("new-password"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(await store.listAccounts()).toEqual([]);
    store.close();
  });

  it("restores an interrupted staged cache when the account still exists", async () => {
    const fixture = await createStore();
    const first = storedFixture();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    await store.save(
      first,
      Buffer.from("first-password"),
      new AbortController().signal,
    );
    const staged = path.join(
      fixture.stateDirectory,
      `.deleting-cache-${first.account.accountId}-aaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    await mkdir(staged, { mode: 0o700 });
    await writeFile(path.join(staged, "message.cache"), "cached", { mode: 0o600 });
    store.close();

    const recovered = new SqliteMailAccountStore(fixture);
    await recovered.initialize();
    await expect(
      readFile(
        path.join(
          fixture.stateDirectory,
          "cache",
          first.account.accountId,
          "message.cache",
        ),
        "utf8",
      ),
    ).resolves.toBe("cached");
    await expect(readFile(path.join(staged, "message.cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    recovered.close();
  });

  it("refuses only a future schema version and opens the current one", async () => {
    const fixture = await createStore();
    const store = new SqliteMailAccountStore(fixture);
    await store.initialize();
    store.close();
    const database = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    database.exec("PRAGMA user_version = 99");
    database.close();
    const future = new SqliteMailAccountStore(fixture);
    await expect(future.initialize()).rejects.toMatchObject({
      code: "account_state_invalid",
    });
    const reset = new DatabaseSync(
      path.join(fixture.stateDirectory, "local.sqlite3"),
    );
    reset.exec("PRAGMA user_version = 2");
    reset.close();
    const current = new SqliteMailAccountStore(fixture);
    await current.initialize();
    expect(await current.listAccounts()).toEqual([]);
    current.close();
  });

  it("runs a ladder step forward and stops at the current schema version", async () => {
    const fixture = await createStore();
    const seeded = new SqliteMailAccountStore(fixture);
    await seeded.initialize();
    seeded.close();
    const databasePath = path.join(fixture.stateDirectory, "local.sqlite3");
    const downgrade = new DatabaseSync(databasePath);
    downgrade.exec("PRAGMA user_version = 1");
    downgrade.close();
    const ladder = (
      SqliteMailAccountStore as unknown as {
        SCHEMA_MIGRATIONS: Map<number, (database: DatabaseSync) => void>;
      }
    ).SCHEMA_MIGRATIONS;
    ladder.set(1, (database) => {
      database
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
        .run("test-migration-step", "ran");
    });
    try {
      const migrated = new SqliteMailAccountStore(fixture);
      await migrated.initialize();
      expect(await migrated.listAccounts()).toEqual([]);
      migrated.close();
    } finally {
      ladder.delete(1);
    }
    const inspect = new DatabaseSync(databasePath);
    expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 2,
    });
    expect(
      inspect
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("test-migration-step"),
    ).toMatchObject({ value: "ran" });
    inspect.close();
  });
});

async function createStore() {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-account-store-"));
  roots.push(root);
  await chmod(root, 0o700);
  const credentialPath = path.join(root, "wrapping.key");
  await writeFile(credentialPath, Buffer.alloc(32, 7), { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  return {
    root,
    stateDirectory: root,
    credentialPath,
    store: new EncryptedFileMailAccountStore({
      stateDirectory: root,
      credentialPath,
    }),
  };
}

function accountFixture() {
  return {
    accountId: "account-a11111111111111111111111111111111",
    emailAddress: "person@example.test",
    endpoint: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
    },
    username: "person@example.test",
    credentialRef: {
      id: "credential-r22222222222222222222222222222222",
      version: 1,
    },
    transportBindingRef: {
      id: "binding-r33333333333333333333333333333333",
      version: 1,
    },
    connectedAt: 1,
  };
}

function storedFixture(index = 1): StoredImapMailAccount {
  const digit = String(index);
  const account = {
    ...accountFixture(),
    accountId: `account-a${digit.repeat(32)}`,
    emailAddress: `person-${index}@example.test`,
    credentialRef: {
      id: `credential-r${digit.repeat(32)}`,
      version: 1,
    },
    transportBindingRef: {
      id: `binding-r${digit.repeat(32)}`,
      version: 1,
    },
  };
  if (index === 1) account.emailAddress = "person@example.test";
  return {
    account,
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  };
}

function storedSmtpFixture(): StoredImapMailAccount {
  const stored = storedFixture();
  return {
    ...stored,
    account: {
      ...stored.account,
      smtp: {
        endpoint: {
          hostname: "smtp.example.test",
          port: 465,
          tls: "implicit",
        },
        username: "person@example.test",
        credentialRef: stored.account.credentialRef,
        transportBindingRef: {
          id: "binding-r44444444444444444444444444444444",
          version: 1,
        },
      },
    },
  };
}

function storedLegacyFixture(): StoredImapMailAccount {
  return {
    ...storedFixture(),
    account: accountFixture(),
  };
}

function gmailGrantFixture(
  override: Partial<{
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly subject: string;
    readonly emailAddress: string;
    readonly grantedAt: number;
  }> = {},
): GmailOAuthGrant {
  const grantedAt = override.grantedAt ?? 1_800_000_000_000;
  return Object.freeze({
    provider: "gmail",
    subject: override.subject ?? "google-subject-1",
    emailAddress: override.emailAddress ?? "person@gmail.com",
    scopes: GMAIL_OAUTH_SCOPES,
    accessToken: Buffer.from(override.accessToken ?? "test-access-token"),
    refreshToken: Buffer.from(override.refreshToken ?? "test-refresh-token"),
    accessTokenExpiresAt: grantedAt + 3_600_000,
    grantedAt,
  });
}
