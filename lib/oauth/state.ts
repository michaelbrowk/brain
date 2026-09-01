import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { z } from "zod";
import type { McpScope } from "./config";
import { OAuthRequestError } from "./config";

const MAX_CLIENTS = 128;
const MAX_CODES = 256;
const MAX_GRANTS = 256;
const MAX_CONSENT_REQUESTS = 256;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60_000;
const REVOKED_GRANT_TTL_MS = 24 * 60 * 60_000;
const STALE_GRANT_TTL_MS = 31 * 24 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const OWNER_PREFIX = "process-owner-";
const MAX_OWNER_CLAIMS = 32;
const STATE_FILE = "state.json";

const scopeSchema = z.enum(["brain:read", "brain:write", "brain:import"]);

const clientSchema = z.object({
  id: z.string().min(16).max(128),
  name: z.string().min(1).max(120),
  redirectUris: z.array(z.string().min(1).max(2_048)).min(1).max(8),
  applicationType: z.enum(["native", "web"]),
  createdAt: z.number().int().nonnegative(),
}).strict();

const refreshStateSchema = z.object({
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(scopeSchema).min(1),
  expiresAt: z.number().int().nonnegative(),
}).strict();

const grantSchema = z.object({
  id: z.string().min(16).max(128),
  clientId: z.string().min(16).max(2_048),
  scopes: z.array(scopeSchema).min(1),
  resource: z.string().url().max(2_048),
  familyId: z.string().min(16).max(128),
  authorizationCodeHash: z.string().regex(/^[a-f0-9]{64}$/),
  codeRedeemedAt: z.number().int().nonnegative().optional(),
  refresh: refreshStateSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
}).strict();

const codeSchema = z.object({
  clientId: z.string().min(16).max(2_048),
  redirectUri: z.string().min(1).max(2_048),
  scopes: z.array(scopeSchema).min(1),
  resource: z.string().url().max(2_048),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  grantId: z.string().min(16).max(128),
  expiresAt: z.number().int().nonnegative(),
  attempts: z.number().int().min(0).max(5),
}).strict();

const consentRequestSchema = z.object({
  expiresAt: z.number().int().nonnegative(),
}).strict();

const stateSchema = z.object({
  version: z.literal(2),
  clients: z.record(z.string(), clientSchema),
  grants: z.record(z.string(), grantSchema),
  codes: z.record(z.string(), codeSchema),
  consentRequests: z.record(z.string(), consentRequestSchema).default({}),
}).strict();

const OAUTH_STATE_VERSION = 2;
type RawOAuthState = Record<string, unknown> & { version?: unknown };
/**
 * Forward-only ladder keyed by the version to migrate FROM; one entry per
 * bump. Exported so the step-execution path stays tested while the ladder
 * is empty.
 */
export const OAUTH_STATE_MIGRATIONS: ReadonlyMap<
  number,
  (state: RawOAuthState) => RawOAuthState
> = new Map();

export function migrateOAuthStateForward(raw: unknown): unknown {
  let state = raw as RawOAuthState;
  for (;;) {
    const version = typeof state?.version === "number" ? state.version : Number.NaN;
    if (version === OAUTH_STATE_VERSION) return state;
    if (!Number.isSafeInteger(version)) {
      throw new Error("OAuth state version is missing");
    }
    if (version > OAUTH_STATE_VERSION) {
      throw new Error(`OAuth state version ${version} is newer than this release`);
    }
    const step = OAUTH_STATE_MIGRATIONS.get(version);
    if (!step) {
      throw new Error(`OAuth state version ${version} has no forward migration`);
    }
    state = { ...step(state), version: version + 1 };
  }
}

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  threadId: z.number().int().nonnegative(),
  processStart: z.string().min(1).max(128),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
}).strict();

type OAuthState = z.infer<typeof stateSchema>;
export type OAuthClient = z.infer<typeof clientSchema>;
export type OAuthGrant = z.infer<typeof grantSchema>;

export interface RefreshCredential {
  grantId: string;
  clientId: string;
  familyId: string;
  generation: number;
  nonce: string;
  scopes: McpScope[];
  resource: string;
  expiresAt: number;
}

export interface ConnectedApp {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
  connectedAt: number;
}

const EMPTY_STATE: OAuthState = {
  version: 2,
  clients: {},
  grants: {},
  codes: {},
  consentRequests: {},
};

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashOAuthSecret(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function nextRefreshGeneration(current: number): number | null {
  return Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : null;
}

function assertCapacity(state: OAuthState): void {
  const counts = [
    ["clients", Object.keys(state.clients).length, MAX_CLIENTS],
    ["grants", Object.keys(state.grants).length, MAX_GRANTS],
    ["codes", Object.keys(state.codes).length, MAX_CODES],
    [
      "consent requests",
      Object.keys(state.consentRequests).length,
      MAX_CONSENT_REQUESTS,
    ],
  ] as const;
  for (const [label, count, max] of counts) {
    if (count > max) throw new Error(`OAuth ${label} exceeded safe capacity`);
  }
}

function prune(state: OAuthState, now: number): void {
  for (const [key, request] of Object.entries(state.consentRequests)) {
    if (request.expiresAt <= now) delete state.consentRequests[key];
  }
  for (const [key, code] of Object.entries(state.codes)) {
    if (code.expiresAt <= now) delete state.codes[key];
  }
  const referencedGrantIds = new Set(
    Object.values(state.codes).map((code) => code.grantId),
  );
  for (const [key, grant] of Object.entries(state.grants)) {
    const revokedAndOld =
      grant.revokedAt !== undefined &&
      grant.revokedAt + REVOKED_GRANT_TTL_MS <= now;
    const refreshActive = Boolean(grant.refresh && grant.refresh.expiresAt > now);
    const stale =
      !referencedGrantIds.has(grant.id) &&
      !refreshActive &&
      grant.createdAt + STALE_GRANT_TTL_MS <= now;
    if (revokedAndOld || stale) delete state.grants[key];
  }
  const referencedClientIds = new Set([
    ...Object.values(state.codes).map((code) => code.clientId),
    ...Object.values(state.grants).map((grant) => grant.clientId),
  ]);
  for (const [key, client] of Object.entries(state.clients)) {
    if (
      !referencedClientIds.has(client.id) &&
      client.createdAt + UNUSED_CLIENT_TTL_MS <= now
    ) {
      delete state.clients[key];
    }
  }
}

function evictOldestUnusedClient(state: OAuthState): boolean {
  const referenced = new Set([
    ...Object.values(state.codes).map((code) => code.clientId),
    ...Object.values(state.grants).map((grant) => grant.clientId),
  ]);
  const candidate = Object.values(state.clients)
    .filter((client) => !referenced.has(client.id))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!candidate) return false;
  delete state.clients[candidate.id];
  return true;
}

function revokeFamily(state: OAuthState, familyId: string, now: number): void {
  for (const grant of Object.values(state.grants)) {
    if (grant.familyId !== familyId) continue;
    if (!grant.revokedAt) grant.revokedAt = now;
    delete grant.refresh;
  }
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function isStrictScopeSubset(
  candidate: readonly McpScope[],
  replacement: readonly McpScope[],
): boolean {
  return (
    candidate.length < replacement.length &&
    candidate.every((scope) => replacement.includes(scope))
  );
}

export class OAuthStateStore {
  readonly file: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {
    if (!path.isAbsolute(directory)) {
      throw new Error("OAuth state directory must be absolute");
    }
    this.file = path.join(/* turbopackIgnore: true */ directory, STATE_FILE);
  }

  async registerClient(input: {
    name: string;
    redirectUris: string[];
    applicationType: "native" | "web";
    now?: number;
  }): Promise<OAuthClient> {
    return this.mutate((state) => {
      if (Object.keys(state.clients).length >= MAX_CLIENTS) {
        if (!evictOldestUnusedClient(state)) {
          throw new Error("OAuth client registry is full");
        }
      }
      const id = `brain_client_${randomToken(24)}`;
      const client: OAuthClient = {
        id,
        name: input.name,
        redirectUris: [...input.redirectUris],
        applicationType: input.applicationType,
        createdAt: input.now ?? Date.now(),
      };
      state.clients[id] = client;
      return client;
    }, input.now);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const state = await this.read();
    return state.clients[clientId] ?? null;
  }

  async authorizationCodeDisposition(
    rawCode: string,
    now = Date.now(),
  ): Promise<"active" | "replay" | "unknown"> {
    const state = await this.read();
    const codeHash = hashOAuthSecret(rawCode);
    const code = state.codes[codeHash];
    if (code && code.expiresAt > now) return "active";
    return Object.values(state.grants).some(
      (grant) =>
        grant.authorizationCodeHash === codeHash &&
        grant.codeRedeemedAt !== undefined,
    )
      ? "replay"
      : "unknown";
  }

  async issueCode(input: {
    clientId: string;
    redirectUri: string;
    scopes: McpScope[];
    resource: string;
    codeChallenge: string;
    requestId: string;
    requestExpiresAt: number;
    now?: number;
  }): Promise<string> {
    return this.mutate((state) => {
      const now = input.now ?? Date.now();
      const client = state.clients[input.clientId];
      if (!client) throw new OAuthRequestError("invalid_client", "Unknown client");
      if (!client.redirectUris.includes(input.redirectUri)) {
        throw new OAuthRequestError("invalid_request", "Redirect URI mismatch");
      }
      if (Object.keys(state.codes).length >= MAX_CODES) {
        throw new Error("OAuth authorization code capacity reached");
      }
      if (Object.keys(state.grants).length >= MAX_GRANTS) {
        throw new Error("OAuth connected app capacity reached");
      }
      markConsentRequestUsed(
        state,
        input.requestId,
        input.requestExpiresAt,
        now,
      );
      const rawCode = randomToken(32);
      const codeHash = hashOAuthSecret(rawCode);
      const grantId = `grant_${randomToken(24)}`;
      const familyId = `family_${randomToken(24)}`;
      state.grants[grantId] = {
        id: grantId,
        clientId: input.clientId,
        scopes: [...input.scopes],
        resource: input.resource,
        familyId,
        authorizationCodeHash: codeHash,
        createdAt: now,
      };
      state.codes[codeHash] = {
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        scopes: [...input.scopes],
        resource: input.resource,
        codeChallenge: input.codeChallenge,
        grantId,
        expiresAt: now + 5 * 60_000,
        attempts: 0,
      };
      return rawCode;
    }, input.now);
  }

  async consumeConsentRequest(input: {
    requestId: string;
    requestExpiresAt: number;
    now?: number;
  }): Promise<void> {
    await this.mutate((state) => {
      const now = input.now ?? Date.now();
      markConsentRequestUsed(
        state,
        input.requestId,
        input.requestExpiresAt,
        now,
      );
    }, input.now);
  }

  async redeemCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
    now?: number;
  }): Promise<{ grant: OAuthGrant; refresh: RefreshCredential }> {
    const outcome = await this.mutate<
      | { ok: true; grant: OAuthGrant; refresh: RefreshCredential }
      | { ok: false; error: OAuthRequestError }
    >((state) => {
      const now = input.now ?? Date.now();
      const codeKey = hashOAuthSecret(input.code);
      const code = state.codes[codeKey];
      if (!code || code.expiresAt <= now) {
        delete state.codes[codeKey];
        const replayed = Object.values(state.grants).find(
          (grant) =>
            grant.authorizationCodeHash === codeKey &&
            grant.codeRedeemedAt !== undefined,
        );
        if (replayed) revokeFamily(state, replayed.familyId, now);
        return {
          ok: false,
          error: new OAuthRequestError("invalid_grant", "Invalid authorization code"),
        };
      }
      const challenge = crypto
        .createHash("sha256")
        .update(input.codeVerifier, "ascii")
        .digest("base64url");
      if (
        code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri ||
        code.resource !== input.resource ||
        !constantTimeEqual(challenge, code.codeChallenge)
      ) {
        code.attempts += 1;
        if (code.attempts >= 5) {
          delete state.codes[codeKey];
          revokeFamily(
            state,
            state.grants[code.grantId]?.familyId ?? "missing",
            now,
          );
        }
        return {
          ok: false,
          error: new OAuthRequestError("invalid_grant", "Invalid authorization code"),
        };
      }
      const grant = state.grants[code.grantId];
      if (!grant || grant.revokedAt) {
        delete state.codes[codeKey];
        return {
          ok: false,
          error: new OAuthRequestError("invalid_grant", "Invalid authorization code"),
        };
      }
      delete state.codes[codeKey];
      const nonce = randomToken(32);
      const refresh = {
        generation: 0,
        nonceHash: hashOAuthSecret(nonce),
        scopes: [...grant.scopes],
        expiresAt: now + REFRESH_TTL_MS,
      } satisfies z.infer<typeof refreshStateSchema>;
      grant.codeRedeemedAt = now;
      grant.refresh = refresh;
      for (const existing of Object.values(state.grants)) {
        if (
          existing.id === grant.id ||
          existing.clientId !== grant.clientId ||
          existing.resource !== grant.resource ||
          existing.revokedAt ||
          !isStrictScopeSubset(existing.scopes, grant.scopes)
        ) {
          continue;
        }
        revokeFamily(state, existing.familyId, now);
      }
      return {
        ok: true,
        grant: structuredClone(grant),
        refresh: refreshCredential(grant, nonce),
      };
    }, input.now);
    if (!outcome.ok) throw outcome.error;
    return { grant: outcome.grant, refresh: outcome.refresh };
  }

  async rotateRefreshToken(input: {
    credential: RefreshCredential;
    requestedScopes?: McpScope[];
    now?: number;
  }): Promise<{ grant: OAuthGrant; refresh: RefreshCredential }> {
    const outcome = await this.mutate<
      | { ok: true; grant: OAuthGrant; refresh: RefreshCredential }
      | { ok: false; error: OAuthRequestError }
    >((state) => {
      const now = input.now ?? Date.now();
      const supplied = input.credential;
      const grant = state.grants[supplied.grantId];
      if (
        !grant ||
        grant.revokedAt ||
        grant.clientId !== supplied.clientId ||
        grant.familyId !== supplied.familyId ||
        grant.resource !== supplied.resource
      ) {
        return invalidRefresh();
      }
      const current = grant.refresh;
      if (!current || current.expiresAt <= now || supplied.expiresAt !== current.expiresAt) {
        delete grant.refresh;
        return invalidRefresh();
      }
      if (supplied.generation < current.generation) {
        revokeFamily(state, grant.familyId, now);
        return {
          ok: false,
          error: new OAuthRequestError("invalid_grant", "Refresh token replayed"),
        };
      }
      if (
        supplied.generation !== current.generation ||
        !constantTimeEqual(hashOAuthSecret(supplied.nonce), current.nonceHash) ||
        !sameScopes(supplied.scopes, current.scopes)
      ) {
        revokeFamily(state, grant.familyId, now);
        return invalidRefresh();
      }
      const requested = input.requestedScopes ?? current.scopes;
      if (requested.some((scope) => !current.scopes.includes(scope))) {
        return {
          ok: false,
          error: new OAuthRequestError("invalid_scope", "Scope was not granted"),
        };
      }
      const nextGeneration = nextRefreshGeneration(current.generation);
      if (nextGeneration === null) {
        revokeFamily(state, grant.familyId, now);
        return invalidRefresh();
      }
      const nonce = randomToken(32);
      grant.refresh = {
        generation: nextGeneration,
        nonceHash: hashOAuthSecret(nonce),
        scopes: [...requested],
        expiresAt: current.expiresAt,
      };
      return {
        ok: true,
        grant: structuredClone(grant),
        refresh: refreshCredential(grant, nonce),
      };
    }, input.now);
    if (!outcome.ok) throw outcome.error;
    return { grant: outcome.grant, refresh: outcome.refresh };
  }

  async isGrantActive(input: {
    grantId: string;
    clientId: string;
    resource: string;
    scopes: readonly string[];
  }): Promise<boolean> {
    const state = await this.read();
    const grant = state.grants[input.grantId];
    return Boolean(
      grant &&
        !grant.revokedAt &&
        grant.clientId === input.clientId &&
        grant.resource === input.resource &&
        input.scopes.every((scope) => grant.scopes.includes(scope as McpScope)),
    );
  }

  async listConnectedApps(): Promise<ConnectedApp[]> {
    const state = await this.read();
    return Object.values(state.grants)
      .filter((grant) => !grant.revokedAt)
      .map((grant) => ({
        grantId: grant.id,
        clientId: grant.clientId,
        clientName: state.clients[grant.clientId]?.name ?? "Unknown app",
        scopes: [...grant.scopes],
        connectedAt: grant.createdAt,
      }))
      .sort((a, b) => b.connectedAt - a.connectedAt);
  }

  async revokeGrant(grantId: string, now = Date.now()): Promise<void> {
    await this.mutate((state) => {
      const grant = state.grants[grantId];
      if (grant) revokeFamily(state, grant.familyId, now);
    }, now);
  }

  async revokeRefreshCredential(
    credential: Pick<RefreshCredential, "grantId" | "clientId" | "familyId">,
    now = Date.now(),
  ): Promise<void> {
    await this.mutate((state) => {
      const grant = state.grants[credential.grantId];
      if (
        grant &&
        grant.clientId === credential.clientId &&
        grant.familyId === credential.familyId
      ) {
        revokeFamily(state, grant.familyId, now);
      }
    }, now);
  }

  async readiness(): Promise<void> {
    await this.read();
  }

  private async read(): Promise<OAuthState> {
    await ensureSingleProcessOwner(this.directory);
    let raw: string;
    try {
      await assertPrivateRegularFile(this.file);
      raw = await fs.readFile(/* turbopackIgnore: true */ this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
    // A migrated state is persisted by the next mutate; reads never write.
    const parsed = stateSchema.parse(migrateOAuthStateForward(JSON.parse(raw)));
    assertCapacity(parsed);
    return parsed;
  }

  private mutate<T>(
    fn: (state: OAuthState) => T | Promise<T>,
    now = Date.now(),
  ): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          const state = await this.read();
          prune(state, now);
          const value = await fn(state);
          assertCapacity(state);
          await secureAtomicWrite(this.directory, this.file, `${JSON.stringify(state)}\n`);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    return result;
  }
}

function markConsentRequestUsed(
  state: OAuthState,
  requestId: string,
  expiresAt: number,
  now: number,
): void {
  if (
    !/^[0-9a-f-]{36}$/.test(requestId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now
  ) {
    throw new OAuthRequestError("invalid_request", "Invalid connection request");
  }
  const key = hashOAuthSecret(requestId);
  if (state.consentRequests[key]) {
    throw new OAuthRequestError(
      "invalid_request",
      "Connection request already used",
    );
  }
  if (Object.keys(state.consentRequests).length >= MAX_CONSENT_REQUESTS) {
    throw new Error("OAuth consent request capacity reached");
  }
  state.consentRequests[key] = { expiresAt };
}

function refreshCredential(grant: OAuthGrant, nonce: string): RefreshCredential {
  if (!grant.refresh) throw new Error("OAuth refresh state is missing");
  return {
    grantId: grant.id,
    clientId: grant.clientId,
    familyId: grant.familyId,
    generation: grant.refresh.generation,
    nonce,
    scopes: [...grant.refresh.scopes],
    resource: grant.resource,
    expiresAt: grant.refresh.expiresAt,
  };
}

function invalidRefresh(): { ok: false; error: OAuthRequestError } {
  return {
    ok: false,
    error: new OAuthRequestError("invalid_grant", "Invalid refresh token"),
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

async function ensurePrivateStateDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(/* turbopackIgnore: true */ directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(/* turbopackIgnore: true */ directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("OAuth state directory must be a real directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("OAuth state directory has the wrong owner");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("OAuth state directory must not be group/world accessible");
  }
}

async function assertPrivateRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(/* turbopackIgnore: true */ file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("OAuth state file must be a regular file");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("OAuth state file has the wrong owner");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("OAuth state file must not be group/world accessible");
  }
}

async function secureAtomicWrite(
  directory: string,
  file: string,
  value: string,
): Promise<void> {
  await ensurePrivateStateDirectory(directory);
  const temporary = path.join(
    /* turbopackIgnore: true */ directory,
    `.oauth-${process.pid}-${randomToken(12)}.tmp`,
  );
  let created = false;
  try {
    const handle = await fs.open(/* turbopackIgnore: true */ temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(
      /* turbopackIgnore: true */ temporary,
      /* turbopackIgnore: true */ file,
    );
    created = false;
    const dirHandle = await fs.open(/* turbopackIgnore: true */ directory, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } finally {
    if (created) {
      await fs.rm(/* turbopackIgnore: true */ temporary, { force: true })
        .catch(() => undefined);
    }
  }
}

type AcceptedProcessOwner = {
  claimFile: string;
  processStart: string;
  nonce: string;
  threadId: number;
};

const ownerGlobal = globalThis as typeof globalThis & {
  __brainOAuthProcessOwners?: Map<
    string,
    AcceptedProcessOwner
  >;
  __brainOAuthOwnerAcquisitions?: Map<string, Promise<void>>;
};
const processOwners =
  ownerGlobal.__brainOAuthProcessOwners ??
  new Map<string, AcceptedProcessOwner>();
ownerGlobal.__brainOAuthProcessOwners = processOwners;
const ownerAcquisitions =
  ownerGlobal.__brainOAuthOwnerAcquisitions ?? new Map<string, Promise<void>>();
ownerGlobal.__brainOAuthOwnerAcquisitions = ownerAcquisitions;
const fallbackProcessStart = `${process.pid}:${Math.floor(
  Date.now() - process.uptime() * 1_000,
)}`;

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      /* turbopackIgnore: true */ `/proc/${pid}/stat`,
      "utf8",
    );
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return fields[19] ? `linux:${fields[19]}` : null;
  } catch {
    if (pid === process.pid) return fallbackProcessStart;
    try {
      process.kill(pid, 0);
      return `live:${pid}`;
    } catch {
      return null;
    }
  }
}

async function ensureSingleProcessOwner(directory: string): Promise<void> {
  const pending = ownerAcquisitions.get(directory);
  if (pending) return pending;

  const acquisition = validateOrAcquireSingleProcessOwner(directory);
  ownerAcquisitions.set(directory, acquisition);
  try {
    await acquisition;
  } finally {
    if (ownerAcquisitions.get(directory) === acquisition) {
      ownerAcquisitions.delete(directory);
    }
  }
}

async function validateOrAcquireSingleProcessOwner(
  directory: string,
): Promise<void> {
  if (await acceptedOwnerClaimExists(directory)) return;
  await acquireSingleProcessOwner(directory);
  if (!(await acceptedOwnerClaimExists(directory))) {
    throw new Error("OAuth process owner claim disappeared during acquisition");
  }
}

async function acceptedOwnerClaimExists(directory: string): Promise<boolean> {
  const accepted = processOwners.get(directory);
  if (!accepted) return false;
  try {
    await assertPrivateRegularFile(accepted.claimFile);
    const existing = ownerSchema.parse(
      JSON.parse((await fs.readFile(
        /* turbopackIgnore: true */ accepted.claimFile,
        "utf8",
      )).slice(0, 4_096)),
    );
    if (
      existing.pid !== process.pid ||
      existing.threadId !== accepted.threadId ||
      existing.threadId !== threadId ||
      existing.processStart !== accepted.processStart ||
      existing.nonce !== accepted.nonce
    ) {
      throw new Error("OAuth accepted process owner claim changed");
    }
    return true;
  } catch (error) {
    processOwners.delete(directory);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireSingleProcessOwner(directory: string): Promise<void> {
  await ensurePrivateStateDirectory(directory);
  const ownStart = (await processStartIdentity(process.pid)) ?? fallbackProcessStart;
  const own = {
    pid: process.pid,
    threadId,
    processStart: ownStart,
    nonce: randomToken(32),
  };
  const claimName = `${OWNER_PREFIX}${own.pid}-${own.threadId}-${own.nonce}.json`;
  const claimFile = path.join(/* turbopackIgnore: true */ directory, claimName);
  const handle = await fs.open(/* turbopackIgnore: true */ claimFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(own)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  let accepted = false;
  try {
    const claimNames = (await fs.readdir(
      /* turbopackIgnore: true */ directory,
    )).filter(
      (name) => name.startsWith(OWNER_PREFIX) && name.endsWith(".json"),
    );
    if (claimNames.length > MAX_OWNER_CLAIMS) {
      throw new Error("OAuth state has too many process owner claims");
    }
    for (const existingName of claimNames) {
      if (existingName === claimName) continue;
      const existingFile = path.join(
        /* turbopackIgnore: true */ directory,
        existingName,
      );
      await assertPrivateRegularFile(existingFile);
      const existing = ownerSchema.parse(
        JSON.parse((await fs.readFile(
          /* turbopackIgnore: true */ existingFile,
          "utf8",
        )).slice(0, 4_096)),
      );

      if (
        existing.pid === process.pid &&
        existing.processStart === ownStart &&
        existing.threadId === threadId
      ) {
        await fs.rm(/* turbopackIgnore: true */ claimFile, { force: true });
        processOwners.set(directory, {
          claimFile: existingFile,
          processStart: existing.processStart,
          nonce: existing.nonce,
          threadId: existing.threadId,
        });
        accepted = true;
        return;
      }

      const liveStart = await processStartIdentity(existing.pid);
      const isLive =
        liveStart !== null &&
        (liveStart.startsWith("live:") || liveStart === existing.processStart);
      if (isLive) {
        throw new Error(
          existing.pid === process.pid
            ? "OAuth state is already owned by another live thread"
            : "OAuth state is already owned by another live process",
        );
      }

      // Claim names contain a random nonce and are never reused. Removing this
      // exact stale file cannot delete a claim created by a racing new process.
      await fs.rm(/* turbopackIgnore: true */ existingFile, { force: true });
    }

    processOwners.set(directory, {
      claimFile,
      processStart: own.processStart,
      nonce: own.nonce,
      threadId: own.threadId,
    });
    accepted = true;
  } finally {
    if (!accepted) {
      await fs.rm(/* turbopackIgnore: true */ claimFile, { force: true })
        .catch(() => undefined);
    }
  }
}

function defaultStateDirectory(): string {
  if (process.env.BRAIN_OAUTH_STATE_DIR) {
    return process.env.BRAIN_OAUTH_STATE_DIR;
  }
  if (process.env.NODE_ENV === "production") {
    return "/var/lib/brain/oauth";
  }
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-oauth-${process.getuid?.() ?? "dev"}`,
  );
}

const globalStore = globalThis as typeof globalThis & {
  __brainOAuthStore?: OAuthStateStore;
  __brainOAuthStoreDirectory?: string;
};

export function getOAuthStateStore(): OAuthStateStore {
  const directory = path.resolve(
    /* turbopackIgnore: true */ defaultStateDirectory(),
  );
  if (
    !globalStore.__brainOAuthStore ||
    globalStore.__brainOAuthStoreDirectory !== directory
  ) {
    globalStore.__brainOAuthStore = new OAuthStateStore(directory);
    globalStore.__brainOAuthStoreDirectory = directory;
  }
  return globalStore.__brainOAuthStore;
}
