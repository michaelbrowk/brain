import {
  constants,
  type FileHandle,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  MailAccountError,
  type MailAccountErrorCode,
  MAX_MAIL_ACCOUNTS,
  type ProvisionedImapAccount,
  type ProvisionedSmtpAccount,
  type StoredGmailMailAccount,
  type StoredImapMailAccount,
  type StoredMailAccount,
  validateProvisionedImapAccount,
  validateStoredMailAccount,
} from "./account-types";
import { isSafeGmailCredentialMetadata } from "../providers/gmail/credentials";
import {
  GmailOAuthError,
  type GmailOAuthGrant,
} from "../providers/gmail/oauth";
import type { GmailOAuthGrantSink } from "../providers/gmail/service-adapter";
import {
  destroyStoredGmailCredential,
  openGmailTokenEnvelope,
  sealGmailTokenEnvelope,
  type StoredGmailCredential,
} from "../providers/gmail/token-envelope";

const STATE_FILE = "account.v1.json";
const CACHE_DIRECTORY = "cache";
const STAGED_CACHE_PATTERN = /^\.deleting-cache-[0-9a-f]{24}$/;
const STATE_TEMP_PATTERN =
  /^\.account\.v1\.[1-9][0-9]{0,9}\.[0-9a-f]{24}\.tmp$/;
const STATE_SCHEMA_VERSION = 1;
const STATE_MAX_BYTES = 32 * 1024;
const MAX_STATE_ROOT_ENTRIES = 64;
const WRAPPING_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const STATE_AAD = Buffer.from("brain-mail-account-state:v1:aes-256-gcm", "utf8");
const LOCAL_DATABASE_FILE = "local.sqlite3";
const LEGACY_ARCHIVE_FILE = "account.v1.migrated.json";
const LOCAL_SCHEMA_VERSION = 2;
const LEGACY_MIGRATION_META_KEY = "legacy_account_v1_migrated";
const SMTP_ACCOUNT_META_PREFIX = "smtp_account_config:";
const ACCOUNT_ID_PATTERN = /^account-a[0-9a-f]{32}$/;
const ACCOUNT_CACHE_STAGE_PATTERN =
  /^\.deleting-cache-(account-a[0-9a-f]{32})-([0-9a-f]{24})$/;
const CREDENTIAL_AAD_PREFIX = "brain-mail-account-credential:v2";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const ACCOUNTS_TABLE_SQL = `CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK(provider_kind IN ('imap', 'gmail')),
  gmail_subject TEXT,
  normalized_email TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected', 'reauth_required')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  credential_version INTEGER NOT NULL CHECK(credential_version >= 1),
  binding_version INTEGER NOT NULL CHECK(binding_version >= 1),
  config_json TEXT CHECK(config_json IS NULL OR json_valid(config_json)),
  CHECK(
    (provider_kind = 'gmail' AND gmail_subject IS NOT NULL) OR
    (provider_kind = 'imap' AND gmail_subject IS NULL)
  ),
  UNIQUE(normalized_email)
) STRICT`;
const GMAIL_SUBJECT_INDEX_SQL = `CREATE UNIQUE INDEX accounts_gmail_subject_unique
  ON accounts(gmail_subject)
  WHERE gmail_subject IS NOT NULL`;

interface EncryptedMailAccountState {
  readonly schemaVersion: 1;
  readonly encryption: {
    readonly algorithm: "aes-256-gcm";
    readonly ciphertext: string;
    readonly iv: string;
    readonly tag: string;
  };
}

interface PlaintextMailAccountState {
  readonly account: ProvisionedImapAccount;
  readonly password: Buffer;
}

export interface LoadedProvisionedAccount {
  readonly account: ProvisionedImapAccount;
  /** The caller owns this buffer and must overwrite it in a finally block. */
  readonly password: Buffer;
}

export interface MailAccountStore {
  readAccount(): Promise<ProvisionedImapAccount | null>;
  loadProvisionedAccount(): Promise<LoadedProvisionedAccount | null>;
  save(
    account: ProvisionedImapAccount,
    password: Buffer,
    signal: AbortSignal,
  ): Promise<void>;
  disconnect(): Promise<boolean>;
}

export interface MultiMailAccountStore {
  readonly localSchemaVersion: 2;
  initialize(): Promise<void>;
  close(): void;
  countAccounts(): Promise<number>;
  listAccounts(): Promise<readonly StoredMailAccount[]>;
  readAccount(accountId: string): Promise<StoredMailAccount | null>;
  loadProvisionedAccount(accountId: string): Promise<LoadedStoredMailAccount | null>;
  save(
    account: StoredImapMailAccount,
    password: Buffer,
    signal: AbortSignal,
  ): Promise<void>;
  updateMetadata(account: StoredMailAccount, signal: AbortSignal): Promise<void>;
  loadGmailCredential(accountId: string): Promise<LoadedStoredGmailAccount | null>;
  deleteAccount(accountId: string): Promise<boolean>;
}

export interface LoadedStoredMailAccount {
  readonly stored: StoredImapMailAccount;
  /** The caller owns this buffer and must overwrite it in a finally block. */
  readonly password: Buffer;
}

export interface LoadedStoredGmailAccount {
  readonly stored: StoredGmailMailAccount;
  /** The caller owns this credential and must destroy it in a finally block. */
  readonly credential: StoredGmailCredential;
}

export class EncryptedFileMailAccountStore implements MailAccountStore {
  private readonly stateDirectory: string;
  private readonly credentialPath: string;
  private readonly statePath: string;
  private readonly cacheRoot: string;
  private readonly beforeCommit: (() => void) | undefined;
  private readonly afterCommit: (() => void) | undefined;
  private cleanupTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly stateDirectory: string;
    readonly credentialPath: string;
    readonly beforeCommit?: () => void;
    readonly afterCommit?: () => void;
  }) {
    this.stateDirectory = requireAbsolutePath(options.stateDirectory);
    this.credentialPath = requireAbsolutePath(options.credentialPath);
    this.statePath = path.join(this.stateDirectory, STATE_FILE);
    this.cacheRoot = path.join(this.stateDirectory, CACHE_DIRECTORY);
    this.beforeCommit = options.beforeCommit;
    this.afterCommit = options.afterCommit;
  }

  async readAccount(): Promise<ProvisionedImapAccount | null> {
    const state = await this.readPlaintextState();
    if (!state) return null;
    state.password.fill(0);
    return state.account;
  }

  async loadProvisionedAccount(): Promise<LoadedProvisionedAccount | null> {
    const state = await this.readPlaintextState();
    if (!state) return null;
    return Object.freeze({ account: state.account, password: state.password });
  }

  async save(
    inputAccount: ProvisionedImapAccount,
    password: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new MailAccountError("imap_connection_timeout");
    }
    if (password.length === 0 || password.length > 4 * 1024 || password.includes(0)) {
      throw new MailAccountError("account_request_invalid");
    }
    const account = validateProvisionedImapAccount(inputAccount);
    let plaintext: Buffer | null = null;
    let key: Buffer | null = null;
    let iv: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let tag: Buffer | null = null;
    let serialized: Buffer | null = null;
    let tempPath: string | null = null;
    try {
      plaintext = Buffer.from(
        JSON.stringify({ account, password: password.toString("base64url") }),
        "utf8",
      );
      if (plaintext.length === 0 || plaintext.length > STATE_MAX_BYTES) {
        throw new MailAccountError("account_request_invalid");
      }
      key = await this.readWrappingKey();
      iv = randomBytes(AES_GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      cipher.setAAD(STATE_AAD);
      ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      tag = cipher.getAuthTag();
      const state: EncryptedMailAccountState = Object.freeze({
        schemaVersion: STATE_SCHEMA_VERSION,
        encryption: Object.freeze({
          algorithm: "aes-256-gcm",
          ciphertext: ciphertext.toString("base64url"),
          iv: iv.toString("base64url"),
          tag: tag.toString("base64url"),
        }),
      });

      serialized = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
      if (serialized.length > STATE_MAX_BYTES) {
        throw new MailAccountError("account_state_invalid");
      }
      await this.assertStateDirectory();
      tempPath = path.join(
        this.stateDirectory,
        `.account.v1.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
      );
      const handle = await open(
        tempPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.beforeCommit?.();
      if (signal.aborted) {
        throw new MailAccountError("imap_connection_timeout");
      }
      // The final abort check and synchronous rename are one event-loop turn,
      // so a cancelled request cannot commit after its abort callback runs.
      renameSync(tempPath, this.statePath);
      tempPath = null;
      this.afterCommit?.();
      await syncDirectory(this.stateDirectory);
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    } finally {
      serialized?.fill(0);
      tag?.fill(0);
      ciphertext?.fill(0);
      iv?.fill(0);
      key?.fill(0);
      plaintext?.fill(0);
      if (tempPath !== null) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
  }

  async disconnect(): Promise<boolean> {
    await this.assertStateDirectory();
    const stateExists = await this.privateStateFileExists();

    // This bootstrap supports exactly one account, so disconnect can detach the
    // entire cache without decrypting state. A lost key or corrupt ciphertext
    // must not trap the user. Rename makes the cache unreachable quickly; slow
    // recursive deletion is recovered in the background or at next startup.
    await this.stageActiveCache();
    await this.purgeStateTemps();
    if (stateExists) {
      try {
        await unlink(this.statePath);
        await syncDirectory(this.stateDirectory);
      } catch {
        throw new MailAccountError("account_state_unavailable");
      }
    }
    this.scheduleStagedCacheCleanup();
    return stateExists;
  }

  /** Completes only cleanup that was already staged by a crashed process. */
  async recoverInterruptedCleanup(): Promise<void> {
    await this.assertStateDirectory();
    await this.cleanupTail;
    await this.purgeStagedCaches();
    await this.purgeStateTemps();
  }

  private async readPlaintextState(): Promise<PlaintextMailAccountState | null> {
    const envelope = await this.readEnvelope();
    if (!envelope) return null;
    let key: Buffer | null = null;
    let iv: Buffer | null = null;
    let tag: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let plaintext: Buffer | null = null;
    try {
      key = await this.readWrappingKey();
      iv = decodeCanonicalBase64Url(
        envelope.encryption.iv,
        AES_GCM_IV_BYTES,
      );
      tag = decodeCanonicalBase64Url(
        envelope.encryption.tag,
        AES_GCM_TAG_BYTES,
      );
      ciphertext = decodeCanonicalBase64Url(
        envelope.encryption.ciphertext,
      );
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(STATE_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (plaintext.length === 0 || plaintext.length > STATE_MAX_BYTES) {
        throw new MailAccountError("account_state_invalid");
      }
      let value: unknown;
      try {
        value = JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new MailAccountError("account_state_invalid");
      }
      return validatePlaintextState(value);
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_invalid");
    } finally {
      key?.fill(0);
      iv?.fill(0);
      tag?.fill(0);
      ciphertext?.fill(0);
      plaintext?.fill(0);
    }
  }

  private async readEnvelope(): Promise<EncryptedMailAccountState | null> {
    await this.assertStateDirectory();
    let handle: FileHandle;
    try {
      handle = await open(
        this.statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw new MailAccountError("account_state_unavailable");
    }

    try {
      const metadata = await handle.stat();
      assertPrivateRegularFile(metadata, currentUid());
      if (metadata.size === 0 || metadata.size > STATE_MAX_BYTES) {
        throw new MailAccountError("account_state_invalid");
      }
      const source = await handle.readFile({ encoding: "utf8" });
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch {
        throw new MailAccountError("account_state_invalid");
      }
      return validateEncryptedState(value);
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    } finally {
      await handle.close();
    }
  }

  private async readWrappingKey(): Promise<Buffer> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.credentialPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new MailAccountError("credential_key_invalid");
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== WRAPPING_KEY_BYTES ||
        !isSafeGmailCredentialMetadata(metadata, currentUid())
      ) {
        throw new MailAccountError("credential_key_invalid");
      }
      const key = await handle.readFile();
      if (key.length !== WRAPPING_KEY_BYTES) {
        key.fill(0);
        throw new MailAccountError("credential_key_invalid");
      }
      return key;
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("credential_key_invalid");
    } finally {
      await handle.close();
    }
  }

  private async assertStateDirectory(): Promise<void> {
    try {
      const handle = await open(
        this.stateDirectory,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isDirectory() ||
          metadata.uid !== currentUid() ||
          (metadata.mode & 0o077) !== 0
        ) {
          throw new MailAccountError("account_state_unavailable");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  private async privateStateFileExists(): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw new MailAccountError("account_state_unavailable");
    }
    try {
      assertPrivateRegularFile(await handle.stat(), currentUid());
    } finally {
      await handle.close();
    }
    return true;
  }

  private async stageActiveCache(): Promise<void> {
    try {
      const entries = await this.readBoundedStateEntries();

      if (entries.includes(CACHE_DIRECTORY)) {
        await assertPrivateDirectory(this.cacheRoot);
        const stagedName = `.deleting-cache-${randomBytes(12).toString("hex")}`;
        await rename(
          this.cacheRoot,
          path.join(this.stateDirectory, stagedName),
        );
        await syncDirectory(this.stateDirectory);
      }
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  private scheduleStagedCacheCleanup(): void {
    this.cleanupTail = this.cleanupTail
      .then(
        () => this.purgeStagedCaches(),
        () => this.purgeStagedCaches(),
      )
      // Startup recovery retries a failed physical cleanup. Never leave a
      // rejected background promise that could terminate the process.
      .catch(() => undefined);
  }

  private async purgeStagedCaches(): Promise<void> {
    try {
      for (const entry of (await this.readBoundedStateEntries()).filter((name) =>
        STAGED_CACHE_PATTERN.test(name),
      )) {
        const stagedPath = path.join(this.stateDirectory, entry);
        await assertPrivateDirectory(stagedPath);
        await rm(stagedPath, { recursive: true, force: false, maxRetries: 0 });
        await syncDirectory(this.stateDirectory);
      }
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  private async purgeStateTemps(): Promise<void> {
    try {
      for (const entry of (await this.readBoundedStateEntries()).filter((name) =>
        STATE_TEMP_PATTERN.test(name),
      )) {
        const tempPath = path.join(this.stateDirectory, entry);
        const handle = await open(
          tempPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          assertPrivateRegularFile(await handle.stat(), currentUid());
        } finally {
          await handle.close();
        }
        await unlink(tempPath);
        await syncDirectory(this.stateDirectory);
      }
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  private async readBoundedStateEntries(): Promise<string[]> {
    const entries = await readdir(this.stateDirectory);
    if (entries.length > MAX_STATE_ROOT_ENTRIES) {
      throw new MailAccountError("account_state_unavailable");
    }
    return entries;
  }
}

/**
 * Durable multi-account state. Non-secret configuration is queryable in
 * SQLite; each credential remains separately wrapped with AES-256-GCM.
 */
export class SqliteMailAccountStore
  implements MultiMailAccountStore, GmailOAuthGrantSink
{
  readonly localSchemaVersion = LOCAL_SCHEMA_VERSION;
  private readonly stateDirectory: string;
  private readonly credentialPath: string;
  private readonly databasePath: string;
  private readonly legacyStatePath: string;
  private readonly legacyArchivePath: string;
  private readonly cacheRoot: string;
  private readonly beforeCommit: (() => void) | undefined;
  private readonly afterCommit: (() => void) | undefined;
  private readonly now: () => number;
  private database: DatabaseSync | null = null;
  private cleanupTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly stateDirectory: string;
    readonly credentialPath: string;
    readonly beforeCommit?: () => void;
    readonly afterCommit?: () => void;
    readonly now?: () => number;
  }) {
    this.stateDirectory = requireAbsolutePath(options.stateDirectory);
    this.credentialPath = requireAbsolutePath(options.credentialPath);
    this.databasePath = path.join(this.stateDirectory, LOCAL_DATABASE_FILE);
    this.legacyStatePath = path.join(this.stateDirectory, STATE_FILE);
    this.legacyArchivePath = path.join(
      this.stateDirectory,
      LEGACY_ARCHIVE_FILE,
    );
    this.cacheRoot = path.join(this.stateDirectory, CACHE_DIRECTORY);
    this.beforeCommit = options.beforeCommit;
    this.afterCommit = options.afterCommit;
    this.now = options.now ?? Date.now;
  }

  isReady(): boolean {
    return this.database !== null;
  }

  async validateReconnectTarget(accountId: string): Promise<void> {
    const stored = await this.readAccount(accountId);
    if (!stored) throw new MailAccountError("account_not_found");
    if (stored.providerKind !== "gmail") {
      throw new MailAccountError("account_request_invalid");
    }
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    await assertPrivateDirectory(this.stateDirectory);
    await this.ensurePrivateDatabaseFile();
    try {
      this.database = new DatabaseSync(this.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      this.database.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      this.initializeSchema();
      await this.ensureSqliteFilesPrivate();
      await this.migrateLegacyAccount();
      await this.recoverInterruptedAccountCleanup();
    } catch (error) {
      this.database?.close();
      this.database = null;
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  close(): void {
    if (!this.database) return;
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.database.close();
      this.database = null;
    }
  }

  async listAccounts(): Promise<readonly StoredMailAccount[]> {
    const rows = this.requireDatabase()
      .prepare(
        `SELECT account_id, provider_kind, gmail_subject, email, display_name, status,
                created_at, updated_at, credential_version, binding_version,
                config_json
           FROM accounts
          ORDER BY created_at ASC, account_id ASC`,
      )
      .all();
    const accounts: StoredMailAccount[] = [];
    for (const row of rows) {
      try {
        accounts.push(this.storedFromRow(row));
      } catch (error) {
        if (
          error instanceof MailAccountError &&
          error.code === "account_state_invalid"
        ) {
          continue;
        }
        throw error;
      }
    }
    return Object.freeze(accounts);
  }

  async countAccounts(): Promise<number> {
    return this.countRawAccounts();
  }

  async readAccount(accountId: string): Promise<StoredMailAccount | null> {
    assertAccountId(accountId, "account_request_invalid");
    const row = this.accountRow(accountId);
    return row ? this.storedFromRow(row) : null;
  }

  async loadProvisionedAccount(
    accountId: string,
  ): Promise<LoadedStoredMailAccount | null> {
    assertAccountId(accountId, "account_request_invalid");
    const row = this.accountRow(accountId);
    if (!row) return null;
    const stored = this.storedFromRow(row);
    if (stored.providerKind !== "imap") {
      throw new MailAccountError("account_state_invalid");
    }
    const credential = this.requireDatabase()
      .prepare(
        `SELECT version, encrypted_blob
           FROM credentials
          WHERE account_id = ? AND kind = 'password'`,
      )
      .get(accountId);
    if (
      !credential ||
      credential.version !== stored.account.credentialRef.version ||
      !(credential.encrypted_blob instanceof Uint8Array)
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    const encrypted = Buffer.from(credential.encrypted_blob);
    try {
      const password = await this.decryptCredential(
        accountId,
        "password",
        stored.account.credentialRef.id,
        credential.version,
        encrypted,
      );
      return Object.freeze({ stored, password });
    } finally {
      encrypted.fill(0);
      credential.encrypted_blob.fill(0);
    }
  }

  async loadGmailCredential(
    accountId: string,
  ): Promise<LoadedStoredGmailAccount | null> {
    assertAccountId(accountId, "account_request_invalid");
    const row = this.accountRow(accountId);
    if (!row) return null;
    const stored = this.storedFromRow(row);
    if (stored.providerKind !== "gmail") {
      throw new MailAccountError("account_state_invalid");
    }
    const credentialRow = this.requireDatabase()
      .prepare(
        `SELECT version, encrypted_blob
           FROM credentials
          WHERE account_id = ? AND kind = 'oauth_refresh'`,
      )
      .get(accountId);
    if (
      !credentialRow ||
      credentialRow.version !== stored.account.credentialRef.version ||
      !(credentialRow.encrypted_blob instanceof Uint8Array)
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    const encrypted = Buffer.from(credentialRow.encrypted_blob);
    let key: Buffer | null = null;
    let credential: StoredGmailCredential | null = null;
    try {
      let envelope: unknown;
      try {
        envelope = JSON.parse(encrypted.toString("utf8"));
      } catch {
        throw new MailAccountError("account_state_invalid");
      }
      key = await readWrappingKey(this.credentialPath);
      try {
        credential = openGmailTokenEnvelope(envelope, key, {
          accountId,
          kind: "oauth_refresh",
          credentialRef: stored.account.credentialRef.id,
          version: stored.account.credentialRef.version,
        });
      } catch (error) {
        if (error instanceof GmailOAuthError) {
          throw new MailAccountError("account_state_invalid");
        }
        throw error;
      }
      if (
        credential.emailAddress !== stored.account.emailAddress ||
        credential.subject !== stored.account.subject ||
        credential.grantedAt !== stored.account.grantedAt
      ) {
        throw new MailAccountError("account_state_invalid");
      }
      const result = Object.freeze({ stored, credential });
      credential = null;
      return result;
    } finally {
      key?.fill(0);
      encrypted.fill(0);
      credentialRow.encrypted_blob.fill(0);
      if (credential) destroyStoredGmailCredential(credential);
    }
  }

  async persistGrant(
    grant: GmailOAuthGrant,
    targetAccountId: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.isReady() || signal.aborted) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    const connectedAt = this.now();
    const previous =
      targetAccountId === null
        ? null
        : await this.readAccount(targetAccountId);
    if (targetAccountId !== null && previous === null) {
      throw new MailAccountError("account_not_found");
    }
    if (previous !== null && previous.providerKind !== "gmail") {
      throw new MailAccountError("account_request_invalid");
    }
    if (previous !== null && previous.account.subject !== grant.subject) {
      throw new MailAccountError("account_already_exists");
    }
    const accountId =
      previous?.account.accountId ??
      `account-a${randomBytes(16).toString("hex")}`;
    const credentialRef =
      previous?.account.credentialRef.id ??
      `credential-r${randomBytes(16).toString("hex")}`;
    const credentialVersion =
      (previous?.account.credentialRef.version ?? 0) + 1;
    if (!Number.isSafeInteger(credentialVersion)) {
      throw new MailAccountError("account_state_unavailable");
    }
    const stored = validateStoredMailAccount(
      {
        account: {
          accountId,
          emailAddress: grant.emailAddress,
          subject: grant.subject,
          credentialRef: {
            id: credentialRef,
            version: credentialVersion,
          },
          connectedAt,
          grantedAt: grant.grantedAt,
        },
        providerKind: "gmail",
        displayName: previous?.displayName ?? null,
        status: "connected",
        createdAt: previous?.createdAt ?? connectedAt,
        updatedAt: connectedAt,
      },
      connectedAt,
    );
    if (stored.providerKind !== "gmail") {
      throw new MailAccountError("account_state_invalid");
    }
    let key: Buffer | null = null;
    let encrypted: Buffer | null = null;
    try {
      key = await readWrappingKey(this.credentialPath);
      const envelope = sealGmailTokenEnvelope(grant, key, {
        accountId,
        kind: "oauth_refresh",
        credentialRef,
        version: credentialVersion,
      });
      encrypted = Buffer.from(JSON.stringify(envelope), "utf8");
      await this.ensureSqliteFilesPrivate();
      this.beforeCommit?.();
      if (signal.aborted) {
        throw new GmailOAuthError("gmail_oauth_unavailable");
      }
      this.transaction(() => {
        if (previous === null) {
          if (this.countRawAccounts() >= MAX_MAIL_ACCOUNTS) {
            throw new MailAccountError("account_limit_reached");
          }
          this.assertUniqueGmailSubject(stored);
          this.assertUniqueProviderEmail(stored);
          this.requireDatabase()
            .prepare(
              `INSERT INTO accounts (
                 account_id, provider_kind, gmail_subject, normalized_email, email,
                 display_name, status, created_at, updated_at,
                 credential_version, binding_version, config_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...this.accountWriteValues(stored, true));
          this.requireDatabase()
            .prepare(
              `INSERT INTO credentials (account_id, kind, version, encrypted_blob)
               VALUES (?, 'oauth_refresh', ?, ?)`,
            )
            .run(accountId, credentialVersion, encrypted!);
          return;
        }

        const currentRow = this.accountRow(accountId);
        if (!currentRow) throw new MailAccountError("account_not_found");
        const current = this.storedFromRow(currentRow);
        if (current.providerKind !== "gmail") {
          throw new MailAccountError("account_request_invalid");
        }
        if (
          current.account.credentialRef.id !== previous.account.credentialRef.id ||
          current.account.credentialRef.version !==
            previous.account.credentialRef.version ||
          current.account.subject !== grant.subject
        ) {
          throw new MailAccountError("account_state_invalid");
        }
        this.assertUniqueGmailSubject(stored);
        this.assertUniqueProviderEmail(stored);
        this.requireDatabase()
          .prepare(
            `UPDATE accounts
                SET provider_kind = ?, gmail_subject = ?, normalized_email = ?, email = ?,
                    display_name = ?, status = ?, updated_at = ?,
                    credential_version = ?, binding_version = ?, config_json = ?
              WHERE account_id = ?`,
          )
          .run(...this.accountWriteValues(stored, false));
        const updated = this.requireDatabase()
          .prepare(
            `UPDATE credentials
                SET version = ?, encrypted_blob = ?
              WHERE account_id = ? AND kind = 'oauth_refresh' AND version = ?`,
          )
          .run(
            credentialVersion,
            encrypted!,
            accountId,
            previous.account.credentialRef.version,
          );
        if (updated.changes !== 1) {
          throw new MailAccountError("account_state_invalid");
        }
      });
      await this.finishCommittedMutation();
    } finally {
      key?.fill(0);
      encrypted?.fill(0);
    }
  }

  async save(
    inputAccount: StoredImapMailAccount,
    password: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new MailAccountError("imap_connection_timeout");
    }
    if (password.length === 0 || password.length > 4 * 1024 || password.includes(0)) {
      throw new MailAccountError("account_request_invalid");
    }
    const stored = validateStoredMailAccount(inputAccount);
    if (stored.providerKind !== "imap") {
      throw new MailAccountError("account_state_invalid");
    }
    if (
      stored.account.smtp &&
      (stored.account.smtp.credentialRef.id !== stored.account.credentialRef.id ||
        stored.account.smtp.credentialRef.version !==
          stored.account.credentialRef.version)
    ) {
      // This schema deliberately supports a shared encrypted mailbox secret
      // through two protocol-specific references. A future independent SMTP
      // secret requires its own credential row and migration, never an
      // implicit fallback here.
      throw new MailAccountError("account_state_invalid");
    }
    const encrypted = await this.encryptCredential(
      stored.account.accountId,
      "password",
      stored.account.credentialRef.id,
      stored.account.credentialRef.version,
      password,
    );
    try {
      await this.ensureSqliteFilesPrivate();
      this.beforeCommit?.();
      if (signal.aborted) {
        throw new MailAccountError("imap_connection_timeout");
      }
      this.transaction(() => {
        const existing = this.accountRow(stored.account.accountId);
        if (!existing && this.countRawAccounts() >= MAX_MAIL_ACCOUNTS) {
          throw new MailAccountError("account_limit_reached");
        }
        this.assertUniqueProviderEmail(stored);
        if (existing) {
          const current = this.storedFromRow(existing);
          if (
            stored.providerKind !== current.providerKind ||
            stored.createdAt !== current.createdAt ||
            stored.updatedAt < current.updatedAt ||
            stored.account.credentialRef.id !==
              current.account.credentialRef.id ||
            stored.account.credentialRef.version !==
              current.account.credentialRef.version + 1 ||
            stored.account.transportBindingRef.id !==
              current.account.transportBindingRef.id ||
            stored.account.transportBindingRef.version !==
              current.account.transportBindingRef.version + 1 ||
            !isValidSmtpBindingTransition(current.account.smtp, stored.account.smtp)
          ) {
            throw new MailAccountError("account_state_invalid");
          }
          this.requireDatabase()
            .prepare(
              `UPDATE accounts
                  SET provider_kind = ?, gmail_subject = ?, normalized_email = ?, email = ?,
                      display_name = ?, status = ?, updated_at = ?,
                      credential_version = ?, binding_version = ?, config_json = ?
                WHERE account_id = ?`,
            )
            .run(...this.accountWriteValues(stored, false));
        } else {
          this.requireDatabase()
            .prepare(
              `INSERT INTO accounts (
                 account_id, provider_kind, gmail_subject, normalized_email, email,
                 display_name, status, created_at, updated_at,
                 credential_version, binding_version, config_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...this.accountWriteValues(stored, true));
        }
        this.writeSmtpAccountMeta(stored);
        this.requireDatabase()
          .prepare(
            `INSERT INTO credentials (account_id, kind, version, encrypted_blob)
             VALUES (?, 'password', ?, ?)
             ON CONFLICT(account_id, kind) DO UPDATE SET
               version = excluded.version,
               encrypted_blob = excluded.encrypted_blob`,
          )
          .run(
            stored.account.accountId,
            stored.account.credentialRef.version,
            encrypted,
          );
      });
      await this.finishCommittedMutation();
    } finally {
      encrypted.fill(0);
    }
  }

  async updateMetadata(
    inputAccount: StoredMailAccount,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new MailAccountError("imap_connection_timeout");
    }
    const stored = validateStoredMailAccount(inputAccount);
    await this.ensureSqliteFilesPrivate();
    this.beforeCommit?.();
    if (signal.aborted) {
      throw new MailAccountError("imap_connection_timeout");
    }
    this.transaction(() => {
      const existing = this.accountRow(stored.account.accountId);
      if (!existing) throw new MailAccountError("account_not_found");
      const current = this.storedFromRow(existing);
      if (
        JSON.stringify(current.account) !== JSON.stringify(stored.account) ||
        current.providerKind !== stored.providerKind ||
        current.status !== stored.status ||
        current.createdAt !== stored.createdAt ||
        stored.updatedAt < current.updatedAt
      ) {
        throw new MailAccountError("account_state_invalid");
      }
      this.assertUniqueProviderEmail(stored);
      this.requireDatabase()
        .prepare(
          `UPDATE accounts
              SET provider_kind = ?, gmail_subject = ?, normalized_email = ?, email = ?,
                  display_name = ?, status = ?, updated_at = ?,
                  credential_version = ?, binding_version = ?, config_json = ?
            WHERE account_id = ?`,
        )
        .run(...this.accountWriteValues(stored, false));
      if (stored.providerKind === "imap") this.writeSmtpAccountMeta(stored);
    });
    await this.finishCommittedMutation();
  }

  /** Marks a connected custom-domain account unusable after definite SMTP AUTH failure. */
  async markAccountReauthRequired(accountId: string): Promise<void> {
    assertAccountId(accountId, "account_request_invalid");
    await this.ensureSqliteFilesPrivate();
    let changed = false;
    this.transaction(() => {
      const row = this.accountRow(accountId);
      if (!row) throw new MailAccountError("account_not_found");
      const current = this.storedFromRow(row);
      if (current.providerKind !== "imap" || !current.account.smtp) {
        throw new MailAccountError("account_state_invalid");
      }
      if (current.status === "reauth_required") return;
      const updatedAt = Math.max(current.updatedAt, this.now());
      const next: StoredImapMailAccount = {
        ...current,
        status: "reauth_required",
        updatedAt,
      };
      const result = this.requireDatabase()
        .prepare(
          `UPDATE accounts
              SET provider_kind = ?, gmail_subject = ?, normalized_email = ?, email = ?,
                  display_name = ?, status = ?, updated_at = ?,
                  credential_version = ?, binding_version = ?, config_json = ?
            WHERE account_id = ?`,
        )
        .run(...this.accountWriteValues(next, false));
      if (result.changes !== 1) {
        throw new MailAccountError("account_state_unavailable");
      }
      this.writeSmtpAccountMeta(next);
      changed = true;
    });
    if (changed) await this.finishCommittedMutation();
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    assertAccountId(accountId, "account_request_invalid");
    if (!this.accountRow(accountId)) return false;
    const staged = await this.stageAccountCache(accountId);
    try {
      await this.ensureSqliteFilesPrivate();
      this.transaction(() => {
        this.requireDatabase()
          .prepare("DELETE FROM meta WHERE key = ?")
          .run(`${SMTP_ACCOUNT_META_PREFIX}${accountId}`);
        const result = this.requireDatabase()
          .prepare("DELETE FROM accounts WHERE account_id = ?")
          .run(accountId);
        if (result.changes !== 1) {
          throw new MailAccountError("account_state_unavailable");
        }
      });
    } catch (error) {
      if (staged) await this.restoreStagedAccountCache(accountId, staged);
      throw error;
    }
    await this.finishCommittedMutation();
    try {
      await this.purgeLegacyArchiveForAccount(accountId);
    } catch {
      // The durable migration marker is retained after account deletion, so
      // both the background queue and the next initialize() can retry safely.
      this.scheduleLegacyArchiveCleanup(accountId);
    }
    try {
      this.requireDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      this.scheduleWalCheckpoint();
    }
    // Recursive cache removal can be much slower than the tiny legacy-envelope
    // cleanup above, so enqueue it last.
    if (staged) this.scheduleStagedAccountCacheCleanup(staged);
    return true;
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new MailAccountError("account_state_unavailable");
    }
    return this.database;
  }

  /**
   * Forward-only schema ladder keyed by the user_version to migrate FROM.
   * Add one step per LOCAL_SCHEMA_VERSION bump; test/data-versions.test.ts
   * opens the oldest supported fixture and fails until the step exists.
   */
  private static readonly SCHEMA_MIGRATIONS: ReadonlyMap<
    number,
    (database: DatabaseSync) => void
  > = new Map();

  private assertSchemaVersion(): void {
    const row = this.requireDatabase().prepare("PRAGMA user_version").get();
    if (!row || row.user_version !== LOCAL_SCHEMA_VERSION) {
      throw new MailAccountError("account_state_invalid");
    }
  }

  private migrateSchemaForward(): void {
    for (;;) {
      const row = this.requireDatabase().prepare("PRAGMA user_version").get();
      const version = row?.user_version;
      if (typeof version !== "number" || !Number.isSafeInteger(version)) {
        throw new MailAccountError("account_state_invalid");
      }
      if (version === LOCAL_SCHEMA_VERSION) return;
      if (version > LOCAL_SCHEMA_VERSION) {
        throw new MailAccountError("account_state_invalid");
      }
      const step = SqliteMailAccountStore.SCHEMA_MIGRATIONS.get(version);
      if (!step) throw new MailAccountError("account_state_invalid");
      this.transaction(() => {
        step(this.requireDatabase());
        this.requireDatabase().exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private initializeSchema(): void {
    const versionRow = this.requireDatabase().prepare("PRAGMA user_version").get();
    if (!versionRow || !Number.isSafeInteger(versionRow.user_version)) {
      throw new MailAccountError("account_state_invalid");
    }
    if (versionRow.user_version === 0) {
      const existing = this.requireDatabase()
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
        )
        .all();
      if (existing.length !== 0) {
        throw new MailAccountError("account_state_invalid");
      }
      this.transaction(() => {
        this.requireDatabase().exec(`
          CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
          ${ACCOUNTS_TABLE_SQL};
          ${GMAIL_SUBJECT_INDEX_SQL};
          CREATE TABLE credentials (
            account_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('password', 'oauth_refresh')),
            version INTEGER NOT NULL CHECK(version >= 1),
            encrypted_blob BLOB NOT NULL,
            PRIMARY KEY(account_id, kind),
            FOREIGN KEY(account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
          ) STRICT;
          PRAGMA user_version = ${LOCAL_SCHEMA_VERSION};
        `);
      });
    } else {
      this.migrateSchemaForward();
    }
    this.assertSchemaVersion();
    const tables = this.requireDatabase()
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    if (
      tables.length !== 3 ||
      tables[0] !== "accounts" ||
      tables[1] !== "credentials" ||
      tables[2] !== "meta"
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    this.assertExactAccountsSchema();
    const integrity = this.requireDatabase().prepare("PRAGMA quick_check").get();
    if (!integrity || integrity.quick_check !== "ok") {
      throw new MailAccountError("account_state_invalid");
    }
    const foreignKeys = this.requireDatabase()
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeys.length !== 0) {
      throw new MailAccountError("account_state_invalid");
    }
  }

  private assertExactAccountsSchema(): void {
    const table = this.requireDatabase()
      .prepare(
        `SELECT type, tbl_name, sql
           FROM sqlite_schema
          WHERE name = 'accounts'`,
      )
      .get();
    const subjectIndex = this.requireDatabase()
      .prepare(
        `SELECT type, tbl_name, sql
           FROM sqlite_schema
          WHERE name = 'accounts_gmail_subject_unique'`,
      )
      .get();
    if (
      !table ||
      table.type !== "table" ||
      table.tbl_name !== "accounts" ||
      typeof table.sql !== "string" ||
      normalizeSchemaSql(table.sql) !== normalizeSchemaSql(ACCOUNTS_TABLE_SQL) ||
      !subjectIndex ||
      subjectIndex.type !== "index" ||
      subjectIndex.tbl_name !== "accounts" ||
      typeof subjectIndex.sql !== "string" ||
      normalizeSchemaSql(subjectIndex.sql) !==
        normalizeSchemaSql(GMAIL_SUBJECT_INDEX_SQL)
    ) {
      throw new MailAccountError("account_state_invalid");
    }

    const columns = this.requireDatabase()
      .prepare("PRAGMA table_xinfo(accounts)")
      .all();
    const expectedNames = [
      "account_id",
      "provider_kind",
      "gmail_subject",
      "normalized_email",
      "email",
      "display_name",
      "status",
      "created_at",
      "updated_at",
      "credential_version",
      "binding_version",
      "config_json",
    ];
    if (
      columns.length !== expectedNames.length ||
      columns.some(
        (column, index) =>
          column.cid !== index ||
          column.name !== expectedNames[index] ||
          column.type !==
            ([
              "created_at",
              "updated_at",
              "credential_version",
              "binding_version",
            ].includes(expectedNames[index])
              ? "INTEGER"
              : "TEXT") ||
          column.hidden !== 0,
      )
    ) {
      throw new MailAccountError("account_state_invalid");
    }
  }

  private countRawAccounts(): number {
    const row = this.requireDatabase()
      .prepare("SELECT COUNT(*) AS count FROM accounts")
      .get();
    if (!row || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
      throw new MailAccountError("account_state_invalid");
    }
    return row.count as number;
  }

  private accountRow(accountId: string): Record<string, unknown> | undefined {
    return this.requireDatabase()
      .prepare(
        `SELECT account_id, provider_kind, gmail_subject, email, display_name, status,
                created_at, updated_at, credential_version, binding_version,
                config_json
           FROM accounts
          WHERE account_id = ?`,
      )
      .get(accountId) as Record<string, unknown> | undefined;
  }

  private smtpAccountFromMeta(
    accountId: string,
    expectedCredentialRefId: unknown,
    expectedCredentialVersion: unknown,
  ):
    | {
        readonly account: Record<string, unknown>;
        readonly status: "connected" | "reauth_required";
      }
    | undefined {
    const row = this.requireDatabase()
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(`${SMTP_ACCOUNT_META_PREFIX}${accountId}`);
    if (row === undefined) return undefined;
    if (typeof row.value !== "string") return undefined;
    let config: unknown;
    try {
      config = JSON.parse(row.value);
    } catch {
      return undefined;
    }
    if (
      !isExactRecord(config, [
        "credentialRefId",
        "credentialVersion",
        "endpoint",
        "schemaVersion",
        "status",
        "transportBindingRefId",
        "transportBindingVersion",
        "username",
      ]) ||
      config.schemaVersion !== 1 ||
      config.credentialRefId !== expectedCredentialRefId ||
      config.credentialVersion !== expectedCredentialVersion ||
      (config.status !== "connected" && config.status !== "reauth_required")
    ) {
      // A previous binary knows nothing about this additive sidecar and may
      // rotate the shared IMAP credential during rollback. A stale sidecar
      // must never poison receive-only account recovery or become send-ready.
      return undefined;
    }
    return {
      account: {
        endpoint: config.endpoint,
        username: config.username,
        credentialRef: {
          id: config.credentialRefId,
          version: config.credentialVersion,
        },
        transportBindingRef: {
          id: config.transportBindingRefId,
          version: config.transportBindingVersion,
        },
      },
      status: config.status,
    };
  }

  private writeSmtpAccountMeta(stored: StoredImapMailAccount): void {
    const key = `${SMTP_ACCOUNT_META_PREFIX}${stored.account.accountId}`;
    if (!stored.account.smtp) {
      this.requireDatabase().prepare("DELETE FROM meta WHERE key = ?").run(key);
      return;
    }
    const smtp = stored.account.smtp;
    const value = JSON.stringify({
      schemaVersion: 1,
      endpoint: smtp.endpoint,
      username: smtp.username,
      credentialRefId: smtp.credentialRef.id,
      credentialVersion: smtp.credentialRef.version,
      status: stored.status,
      transportBindingRefId: smtp.transportBindingRef.id,
      transportBindingVersion: smtp.transportBindingRef.version,
    });
    this.requireDatabase()
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private storedFromRow(row: Record<string, unknown>): StoredMailAccount {
    if (
      typeof row.config_json !== "string" ||
      typeof row.account_id !== "string" ||
      (row.provider_kind !== "imap" && row.provider_kind !== "gmail") ||
      (row.gmail_subject !== null && typeof row.gmail_subject !== "string") ||
      typeof row.email !== "string" ||
      (row.display_name !== null && typeof row.display_name !== "string") ||
      (row.status !== "connected" && row.status !== "reauth_required") ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at) ||
      !Number.isSafeInteger(row.credential_version) ||
      !Number.isSafeInteger(row.binding_version)
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    let config: unknown;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      throw new MailAccountError("account_state_invalid");
    }
    if (row.provider_kind === "gmail") {
      if (
        typeof row.gmail_subject !== "string" ||
        !isExactRecord(config, [
          "connectedAt",
          "credentialRefId",
          "grantedAt",
          "schemaVersion",
          "subject",
        ]) ||
        config.schemaVersion !== 1 ||
        config.subject !== row.gmail_subject ||
        row.binding_version !== 1
      ) {
        throw new MailAccountError("account_state_invalid");
      }
      return validateStoredMailAccount(
        {
          account: {
            accountId: row.account_id,
            emailAddress: row.email,
            subject: config.subject,
            credentialRef: {
              id: config.credentialRefId,
              version: row.credential_version,
            },
            connectedAt: config.connectedAt,
            grantedAt: config.grantedAt,
          },
          providerKind: "gmail",
          displayName: row.display_name,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        this.now(),
      );
    }
    if (row.gmail_subject !== null) {
      throw new MailAccountError("account_state_invalid");
    }
    let provisioned: Record<string, unknown>;
    let effectiveStatus = row.status;
    if (
      isExactRecord(config, [
        "connectedAt",
        "credentialRefId",
        "endpoint",
        "schemaVersion",
        "transportBindingRefId",
        "username",
      ]) &&
      config.schemaVersion === 1
    ) {
      const smtp = this.smtpAccountFromMeta(
        row.account_id,
        config.credentialRefId,
        row.credential_version,
      );
      if (smtp && effectiveStatus === "connected") {
        effectiveStatus = smtp.status;
      }
      provisioned = {
        accountId: row.account_id,
        emailAddress: row.email,
        endpoint: config.endpoint,
        username: config.username,
        credentialRef: {
          id: config.credentialRefId,
          version: row.credential_version,
        },
        transportBindingRef: {
          id: config.transportBindingRefId,
          version: row.binding_version,
        },
        ...(smtp ? { smtp: smtp.account } : {}),
        connectedAt: config.connectedAt,
      };
    } else if (
      isExactRecord(config, [
        "connectedAt",
        "credentialRefId",
        "endpoint",
        "schemaVersion",
        "smtp",
        "transportBindingRefId",
        "username",
      ]) &&
      config.schemaVersion === 2 &&
      (config.smtp === null ||
        isExactRecord(config.smtp, [
          "credentialRefId",
          "credentialVersion",
          "endpoint",
          "transportBindingRefId",
          "transportBindingVersion",
          "username",
        ]))
    ) {
      provisioned = {
        accountId: row.account_id,
        emailAddress: row.email,
        endpoint: config.endpoint,
        username: config.username,
        credentialRef: {
          id: config.credentialRefId,
          version: row.credential_version,
        },
        transportBindingRef: {
          id: config.transportBindingRefId,
          version: row.binding_version,
        },
        ...(config.smtp === null
          ? {}
          : {
              smtp: {
                endpoint: config.smtp.endpoint,
                username: config.smtp.username,
                credentialRef: {
                  id: config.smtp.credentialRefId,
                  version: config.smtp.credentialVersion,
                },
                transportBindingRef: {
                  id: config.smtp.transportBindingRefId,
                  version: config.smtp.transportBindingVersion,
                },
              },
            }),
        connectedAt: config.connectedAt,
      };
    } else {
      throw new MailAccountError("account_state_invalid");
    }
    return validateStoredMailAccount(
      {
        account: provisioned,
        providerKind: row.provider_kind,
        displayName: row.display_name,
        status: effectiveStatus,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      this.now(),
    );
  }

  private accountWriteValues(
    stored: StoredMailAccount,
    insert: boolean,
  ): (string | number | null)[] {
    const config = JSON.stringify(
      stored.providerKind === "imap"
        ? {
            // SMTP metadata lives in the existing meta table. Keeping the
            // authoritative account row on exact schema v1 means the previous
            // release can still read every account after a canary rollback.
            schemaVersion: 1,
            endpoint: stored.account.endpoint,
            username: stored.account.username,
            credentialRefId: stored.account.credentialRef.id,
            transportBindingRefId: stored.account.transportBindingRef.id,
            connectedAt: stored.account.connectedAt,
          }
        : {
            schemaVersion: 1,
            subject: stored.account.subject,
            credentialRefId: stored.account.credentialRef.id,
            connectedAt: stored.account.connectedAt,
            grantedAt: stored.account.grantedAt,
          },
    );
    const bindingVersion =
      stored.providerKind === "imap"
        ? stored.account.transportBindingRef.version
        : 1;
    const common: (string | number | null)[] = [
      stored.providerKind,
      stored.providerKind === "gmail" ? stored.account.subject : null,
      normalizeProviderEmail(stored.account.emailAddress),
      stored.account.emailAddress,
      stored.displayName,
      stored.providerKind === "imap" && stored.account.smtp
        ? "connected"
        : stored.status,
    ];
    if (insert) {
      return [
        stored.account.accountId,
        ...common,
        stored.createdAt,
        stored.updatedAt,
        stored.account.credentialRef.version,
        bindingVersion,
        config,
      ];
    }
    return [
      ...common,
      stored.updatedAt,
      stored.account.credentialRef.version,
      bindingVersion,
      config,
      stored.account.accountId,
    ];
  }

  private assertUniqueProviderEmail(stored: StoredMailAccount): void {
    const conflict = this.requireDatabase()
      .prepare(
        `SELECT account_id FROM accounts
          WHERE normalized_email = ? AND account_id <> ?`,
      )
      .get(
        normalizeProviderEmail(stored.account.emailAddress),
        stored.account.accountId,
      );
    if (conflict) throw new MailAccountError("account_already_exists");
  }

  private assertUniqueGmailSubject(stored: StoredMailAccount): void {
    if (stored.providerKind !== "gmail") return;
    const conflict = this.requireDatabase()
      .prepare(
        `SELECT account_id FROM accounts
          WHERE gmail_subject = ? AND account_id <> ?`,
      )
      .get(stored.account.subject, stored.account.accountId);
    if (conflict) throw new MailAccountError("account_already_exists");
  }

  private transaction(operation: () => void): void {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    }
  }

  private async encryptCredential(
    accountId: string,
    kind: "password",
    credentialId: string,
    version: number,
    password: Buffer,
  ): Promise<Buffer> {
    let key: Buffer | null = null;
    let iv: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let tag: Buffer | null = null;
    try {
      key = await readWrappingKey(this.credentialPath);
      iv = randomBytes(AES_GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      cipher.setAAD(credentialAad(accountId, kind, credentialId, version));
      ciphertext = Buffer.concat([cipher.update(password), cipher.final()]);
      tag = cipher.getAuthTag();
      return Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          algorithm: "aes-256-gcm",
          ciphertext: ciphertext.toString("base64url"),
          iv: iv.toString("base64url"),
          tag: tag.toString("base64url"),
        }),
        "utf8",
      );
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_unavailable");
    } finally {
      key?.fill(0);
      iv?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  private async decryptCredential(
    accountId: string,
    kind: "password",
    credentialId: string,
    version: number,
    encrypted: Buffer,
  ): Promise<Buffer> {
    let value: unknown;
    try {
      value = JSON.parse(encrypted.toString("utf8"));
    } catch {
      throw new MailAccountError("account_state_invalid");
    }
    if (
      !isExactRecord(value, [
        "algorithm",
        "ciphertext",
        "iv",
        "schemaVersion",
        "tag",
      ]) ||
      value.schemaVersion !== 1 ||
      value.algorithm !== "aes-256-gcm" ||
      typeof value.ciphertext !== "string" ||
      typeof value.iv !== "string" ||
      typeof value.tag !== "string"
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    let key: Buffer | null = null;
    let iv: Buffer | null = null;
    let tag: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    try {
      key = await readWrappingKey(this.credentialPath);
      iv = decodeCanonicalBase64Url(value.iv, AES_GCM_IV_BYTES);
      tag = decodeCanonicalBase64Url(value.tag, AES_GCM_TAG_BYTES);
      ciphertext = decodeCanonicalBase64Url(value.ciphertext);
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(credentialAad(accountId, kind, credentialId, version));
      decipher.setAuthTag(tag);
      const password = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (
        password.length === 0 ||
        password.length > 4 * 1024 ||
        password.includes(0)
      ) {
        password.fill(0);
        throw new MailAccountError("account_state_invalid");
      }
      return password;
    } catch (error) {
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("account_state_invalid");
    } finally {
      key?.fill(0);
      iv?.fill(0);
      tag?.fill(0);
      ciphertext?.fill(0);
    }
  }

  private async migrateLegacyAccount(): Promise<void> {
    const marker = this.requireDatabase()
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(LEGACY_MIGRATION_META_KEY);
    if (marker) {
      if (
        typeof marker.value !== "string" ||
        !ACCOUNT_ID_PATTERN.test(marker.value)
      ) {
        throw new MailAccountError("account_state_invalid");
      }
      if (this.accountRow(marker.value)) {
        await this.finishLegacyArtifactMigration(marker.value);
      } else {
        await this.purgeLegacyArchiveForAccount(marker.value);
      }
      return;
    }

    const entries = await this.readBoundedStateEntries();
    if (entries.includes(LEGACY_ARCHIVE_FILE)) {
      throw new MailAccountError("account_state_unavailable");
    }
    if (!entries.includes(STATE_FILE)) return;

    const legacy = new EncryptedFileMailAccountStore({
      stateDirectory: this.stateDirectory,
      credentialPath: this.credentialPath,
    });
    await legacy.recoverInterruptedCleanup();
    const loaded = await legacy.loadProvisionedAccount();
    if (!loaded) return;
    const stored = validateStoredMailAccount({
      account: loaded.account,
      providerKind: "imap",
      displayName: null,
      status: "connected",
      createdAt: loaded.account.connectedAt,
      updatedAt: loaded.account.connectedAt,
    });
    if (stored.providerKind !== "imap") {
      throw new MailAccountError("account_state_invalid");
    }
    let encrypted: Buffer | null = null;
    try {
      encrypted = await this.encryptCredential(
        stored.account.accountId,
        "password",
        stored.account.credentialRef.id,
        stored.account.credentialRef.version,
        loaded.password,
      );
      this.transaction(() => {
        if (this.countRawAccounts() >= MAX_MAIL_ACCOUNTS) {
          throw new MailAccountError("account_limit_reached");
        }
        this.assertUniqueProviderEmail(stored);
        this.requireDatabase()
          .prepare(
            `INSERT INTO accounts (
               account_id, provider_kind, gmail_subject, normalized_email, email,
               display_name, status, created_at, updated_at,
               credential_version, binding_version, config_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...this.accountWriteValues(stored, true));
        this.requireDatabase()
          .prepare(
            `INSERT INTO credentials (account_id, kind, version, encrypted_blob)
             VALUES (?, 'password', ?, ?)`,
          )
          .run(
            stored.account.accountId,
            stored.account.credentialRef.version,
            encrypted!,
          );
        this.requireDatabase()
          .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
          .run(LEGACY_MIGRATION_META_KEY, stored.account.accountId);
      });
      await this.ensureSqliteFilesPrivate();
    } finally {
      encrypted?.fill(0);
      loaded.password.fill(0);
    }
    await this.finishLegacyArtifactMigration(stored.account.accountId);
  }

  private async finishLegacyArtifactMigration(accountId: string): Promise<void> {
    const entries = await this.readBoundedStateEntries();
    if (
      entries.includes(STATE_FILE) &&
      entries.includes(LEGACY_ARCHIVE_FILE)
    ) {
      throw new MailAccountError("account_state_unavailable");
    }
    if (entries.includes(STATE_FILE)) {
      await assertPrivateRegularPath(this.legacyStatePath);
      await rename(this.legacyStatePath, this.legacyArchivePath);
      await syncDirectory(this.stateDirectory);
    }
    await this.migrateLegacyCache(accountId);
  }

  private async purgeLegacyArchiveForAccount(accountId: string): Promise<void> {
    const marker = this.requireDatabase()
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(LEGACY_MIGRATION_META_KEY);
    if (!marker || marker.value !== accountId) return;
    const entries = await this.readBoundedStateEntries();
    if (entries.includes(STATE_FILE)) {
      throw new MailAccountError("account_state_unavailable");
    }
    if (!entries.includes(LEGACY_ARCHIVE_FILE)) return;
    await assertPrivateRegularPath(this.legacyArchivePath);
    await unlink(this.legacyArchivePath);
    await syncDirectory(this.stateDirectory);
  }

  private async migrateLegacyCache(accountId: string): Promise<void> {
    const staged = path.join(
      this.stateDirectory,
      `.migrating-cache-${accountId}`,
    );
    const stateEntries = await this.readBoundedStateEntries();
    const stagedPresent = stateEntries.includes(path.basename(staged));
    if (stagedPresent) await assertPrivateDirectory(staged);

    const cacheHandle = await openPrivateDirectoryIfPresent(this.cacheRoot);
    if (!cacheHandle) {
      if (!stagedPresent) return;
      await mkdir(this.cacheRoot, { mode: 0o700 });
      await rename(staged, path.join(this.cacheRoot, accountId));
      await syncDirectory(this.cacheRoot);
      await syncDirectory(this.stateDirectory);
      return;
    }
    await cacheHandle.close();
    const entries = await readdir(this.cacheRoot);
    if (entries.includes(accountId)) {
      await assertPrivateDirectory(path.join(this.cacheRoot, accountId));
      if (entries.length !== 1 || stagedPresent) {
        throw new MailAccountError("account_state_unavailable");
      }
      return;
    }
    if (entries.some((entry) => ACCOUNT_ID_PATTERN.test(entry))) {
      throw new MailAccountError("account_state_unavailable");
    }
    if (stagedPresent) {
      if (entries.length !== 0) {
        throw new MailAccountError("account_state_unavailable");
      }
      await rename(staged, path.join(this.cacheRoot, accountId));
      await syncDirectory(this.cacheRoot);
      await syncDirectory(this.stateDirectory);
      return;
    }
    await rename(this.cacheRoot, staged);
    await mkdir(this.cacheRoot, { mode: 0o700 });
    await rename(staged, path.join(this.cacheRoot, accountId));
    await syncDirectory(this.cacheRoot);
    await syncDirectory(this.stateDirectory);
  }

  private async stageAccountCache(accountId: string): Promise<string | null> {
    const cacheHandle = await openPrivateDirectoryIfPresent(this.cacheRoot);
    if (!cacheHandle) return null;
    await cacheHandle.close();
    const accountCache = path.join(this.cacheRoot, accountId);
    const accountHandle = await openPrivateDirectoryIfPresent(accountCache);
    if (!accountHandle) return null;
    await accountHandle.close();
    const staged = path.join(
      this.stateDirectory,
      `.deleting-cache-${accountId}-${randomBytes(12).toString("hex")}`,
    );
    await rename(accountCache, staged);
    await syncDirectory(this.cacheRoot);
    await syncDirectory(this.stateDirectory);
    return staged;
  }

  private async restoreStagedAccountCache(
    accountId: string,
    staged: string,
  ): Promise<void> {
    await this.ensureCacheRoot();
    const destination = path.join(this.cacheRoot, accountId);
    const present = await openPrivateDirectoryIfPresent(destination);
    if (present) {
      await present.close();
      throw new MailAccountError("account_state_unavailable");
    }
    await rename(staged, destination);
    await syncDirectory(this.cacheRoot);
    await syncDirectory(this.stateDirectory);
  }

  private scheduleStagedAccountCacheCleanup(staged: string): void {
    this.cleanupTail = this.cleanupTail
      .then(
        () => this.purgeStagedAccountCache(staged),
        () => this.purgeStagedAccountCache(staged),
      )
      .catch(() => undefined);
  }

  /**
   * A SQLite transaction is the authoritative point of no return. Everything
   * after it is recoverable housekeeping and must never turn a committed
   * mutation into a false API failure.
   */
  private async finishCommittedMutation(): Promise<void> {
    try {
      this.afterCommit?.();
    } catch {
      // Test hooks and diagnostics cannot rewrite the committed outcome.
    }
    try {
      await this.ensureSqliteFilesPrivate();
    } catch {
      this.scheduleSqlitePermissionCheck();
    }
  }

  private scheduleLegacyArchiveCleanup(accountId: string): void {
    this.cleanupTail = this.cleanupTail
      .then(
        () => this.purgeLegacyArchiveForAccount(accountId),
        () => this.purgeLegacyArchiveForAccount(accountId),
      )
      .catch(() => undefined);
  }

  private scheduleSqlitePermissionCheck(): void {
    this.cleanupTail = this.cleanupTail
      .then(
        () => this.ensureSqliteFilesPrivate(),
        () => this.ensureSqliteFilesPrivate(),
      )
      .catch(() => undefined);
  }

  private scheduleWalCheckpoint(): void {
    const checkpoint = async () => {
      this.requireDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    };
    this.cleanupTail = this.cleanupTail
      .then(checkpoint, checkpoint)
      .catch(() => undefined);
  }

  private async purgeStagedAccountCache(staged: string): Promise<void> {
    await assertPrivateDirectory(staged);
    await rm(staged, { recursive: true, force: false, maxRetries: 0 });
    await syncDirectory(this.stateDirectory);
  }

  private async recoverInterruptedAccountCleanup(): Promise<void> {
    await this.cleanupTail;
    for (const entry of await this.readBoundedStateEntries()) {
      const match = ACCOUNT_CACHE_STAGE_PATTERN.exec(entry);
      if (!match) continue;
      const accountId = match[1];
      const staged = path.join(this.stateDirectory, entry);
      await assertPrivateDirectory(staged);
      if (this.accountRow(accountId)) {
        await this.restoreStagedAccountCache(accountId, staged);
      } else {
        await this.purgeStagedAccountCache(staged);
      }
    }
  }

  private async ensureCacheRoot(): Promise<void> {
    const present = await openPrivateDirectoryIfPresent(this.cacheRoot);
    if (present) {
      await present.close();
      return;
    }
    await mkdir(this.cacheRoot, { mode: 0o700 });
    await syncDirectory(this.stateDirectory);
  }

  private async ensurePrivateDatabaseFile(): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.databasePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.sync();
      await handle.close();
      await syncDirectory(this.stateDirectory);
      return;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new MailAccountError("account_state_unavailable");
      }
    }
    await assertPrivateRegularPath(this.databasePath);
  }

  private async ensureSqliteFilesPrivate(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${this.databasePath}${suffix}`;
      let handle: FileHandle;
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw new MailAccountError("account_state_unavailable");
      }
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          metadata.uid !== currentUid()
        ) {
          throw new MailAccountError("account_state_unavailable");
        }
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
  }

  private async readBoundedStateEntries(): Promise<string[]> {
    const entries = await readdir(this.stateDirectory);
    if (entries.length > MAX_STATE_ROOT_ENTRIES) {
      throw new MailAccountError("account_state_unavailable");
    }
    return entries;
  }
}

/** Test and future cache code use this helper to create the exact private root. */
export async function createMailCacheRoot(stateDirectory: string): Promise<string> {
  const root = path.join(requireAbsolutePath(stateDirectory), CACHE_DIRECTORY);
  await mkdir(root, { mode: 0o700 });
  return root;
}

function validateEncryptedState(value: unknown): EncryptedMailAccountState {
  if (
    !isExactRecord(value, ["encryption", "schemaVersion"]) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    !isExactRecord(value.encryption, ["algorithm", "ciphertext", "iv", "tag"]) ||
    value.encryption.algorithm !== "aes-256-gcm" ||
    typeof value.encryption.ciphertext !== "string" ||
    typeof value.encryption.iv !== "string" ||
    typeof value.encryption.tag !== "string"
  ) {
    throw new MailAccountError("account_state_invalid");
  }
  decodeCanonicalBase64Url(value.encryption.iv, AES_GCM_IV_BYTES).fill(0);
  decodeCanonicalBase64Url(value.encryption.tag, AES_GCM_TAG_BYTES).fill(0);
  decodeCanonicalBase64Url(value.encryption.ciphertext).fill(0);
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    encryption: Object.freeze({
      algorithm: "aes-256-gcm",
      ciphertext: value.encryption.ciphertext,
      iv: value.encryption.iv,
      tag: value.encryption.tag,
    }),
  });
}

function validatePlaintextState(value: unknown): PlaintextMailAccountState {
  if (
    !isExactRecord(value, ["account", "password"]) ||
    typeof value.password !== "string"
  ) {
    throw new MailAccountError("account_state_invalid");
  }
  const password = decodeCanonicalBase64Url(value.password);
  try {
    if (
      password.length === 0 ||
      password.length > 4 * 1024 ||
      password.includes(0)
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    return Object.freeze({
      account: validateProvisionedImapAccount(value.account),
      password,
    });
  } catch (error) {
    password.fill(0);
    if (error instanceof MailAccountError) throw error;
    throw new MailAccountError("account_state_invalid");
  }
}

function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MailAccountError("account_state_invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    throw new MailAccountError("account_state_invalid");
  }
  return decoded;
}

async function readWrappingKey(credentialPath: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(
      requireAbsolutePath(credentialPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new MailAccountError("credential_key_invalid");
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== WRAPPING_KEY_BYTES ||
      !isSafeGmailCredentialMetadata(metadata, currentUid())
    ) {
      throw new MailAccountError("credential_key_invalid");
    }
    const key = await handle.readFile();
    if (key.length !== WRAPPING_KEY_BYTES) {
      key.fill(0);
      throw new MailAccountError("credential_key_invalid");
    }
    return key;
  } catch (error) {
    if (error instanceof MailAccountError) throw error;
    throw new MailAccountError("credential_key_invalid");
  } finally {
    await handle.close();
  }
}

function credentialAad(
  accountId: string,
  kind: "password",
  credentialId: string,
  version: number,
): Buffer {
  assertAccountId(accountId, "account_state_invalid");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MailAccountError("account_state_invalid");
  }
  if (!/^credential-r[0-9a-f]{32}$/.test(credentialId)) {
    throw new MailAccountError("account_state_invalid");
  }
  return Buffer.from(
    `${CREDENTIAL_AAD_PREFIX}:${accountId}:${kind}:${credentialId}:v${version}`,
    "utf8",
  );
}

function normalizeProviderEmail(emailAddress: string): string {
  return emailAddress.normalize("NFC").toLocaleLowerCase("en-US");
}

function isValidSmtpBindingTransition(
  current: ProvisionedSmtpAccount | undefined,
  next: ProvisionedSmtpAccount | undefined,
): boolean {
  if (!current) {
    return next === undefined || next.transportBindingRef.version === 1;
  }
  if (!next) return true;
  return (
    next.transportBindingRef.id === current.transportBindingRef.id &&
    next.transportBindingRef.version ===
      current.transportBindingRef.version + 1
  );
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function assertAccountId(
  accountId: string,
  code: Extract<
    MailAccountErrorCode,
    "account_request_invalid" | "account_state_invalid"
  >,
): void {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new MailAccountError(code);
  }
}

async function assertPrivateRegularPath(target: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new MailAccountError("account_state_unavailable");
    }
    throw new MailAccountError("account_state_unavailable");
  }
  try {
    assertPrivateRegularFile(await handle.stat(), currentUid());
  } finally {
    await handle.close();
  }
}

async function openPrivateDirectoryIfPresent(
  directory: string,
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new MailAccountError("account_state_unavailable");
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new MailAccountError("account_state_unavailable");
    }
  } catch (error) {
    await handle.close();
    if (error instanceof MailAccountError) throw error;
    throw new MailAccountError("account_state_unavailable");
  }
  return handle;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const handle = await openPrivateDirectoryIfPresent(directory);
  if (!handle) throw new MailAccountError("account_state_unavailable");
  await handle.close();
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertPrivateRegularFile(
  metadata: {
    isFile(): boolean;
    readonly mode: number;
    readonly nlink: number;
    readonly uid: number;
  },
  owner: number,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.uid !== owner ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new MailAccountError("account_state_invalid");
  }
}

function requireAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value !== path.resolve(value) ||
    value.includes("\u0000")
  ) {
    throw new MailAccountError("account_state_unavailable");
  }
  return value;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    return false;
  }
  return fields.every((field) => {
    const descriptor = descriptors[field];
    return descriptor !== undefined && "value" in descriptor;
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function currentUid(): number {
  if (typeof process.geteuid !== "function") {
    throw new MailAccountError("account_state_unavailable");
  }
  return process.geteuid();
}
