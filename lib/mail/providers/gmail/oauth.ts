import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";

export { GMAIL_OAUTH_TRANSACTION_COOKIE } from "./contract";

export const GMAIL_OAUTH_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
] as const);

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = Object.freeze([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const GOOGLE_AUTHORIZATION_RESPONSE_ISSUER = "https://accounts.google.com";
const GOOGLE_EMAIL_SCOPE_ALIAS =
  "https://www.googleapis.com/auth/userinfo.email";
const TRANSACTION_VERSION = 1;
const TRANSACTION_TTL_MS = 10 * 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_AUTHORIZATION_CODE_BYTES = 512;
const MAX_TOKEN_BYTES = 16 * 1024;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const TRANSACTION_AAD = Buffer.from(
  "brain-mail:gmail-oauth-transaction:v1",
  "utf8",
);
const GOOGLE_JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT));

export type GmailOAuthErrorCode =
  | "gmail_oauth_unavailable"
  | "gmail_oauth_request_invalid"
  | "gmail_oauth_state_invalid"
  | "gmail_oauth_provider_denied"
  | "gmail_oauth_provider_error"
  | "gmail_oauth_token_invalid"
  | "gmail_oauth_scope_invalid"
  | "gmail_oauth_identity_invalid";

export class GmailOAuthError extends Error {
  constructor(readonly code: GmailOAuthErrorCode) {
    super(code);
    this.name = "GmailOAuthError";
  }
}

export interface GmailOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly publicOrigin: string;
  readonly redirectUri: string;
}

export interface GmailOAuthTransaction {
  readonly version: 1;
  readonly transactionId: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly targetAccountId: string | null;
}

export interface GmailOAuthAuthorization {
  readonly authorizationUrl: string;
  readonly transactionCookieValue: string;
  readonly expiresAt: number;
}

export interface GmailIdentity {
  readonly subject: string;
  readonly emailAddress: string;
}

export interface GmailOAuthGrant {
  readonly provider: "gmail";
  readonly subject: string;
  readonly emailAddress: string;
  readonly scopes: typeof GMAIL_OAUTH_SCOPES;
  /** The receiving sink owns these buffers and must wipe them after sealing. */
  readonly accessToken: Buffer;
  readonly refreshToken: Buffer;
  readonly accessTokenExpiresAt: number;
  readonly grantedAt: number;
}

export interface GmailOAuthCompletion {
  readonly grant: GmailOAuthGrant;
  readonly targetAccountId: string | null;
}

export interface GmailOAuthTransactionStore {
  issue(transactionId: string, expiresAt: number, now: number): void;
  consume(transactionId: string, now: number): boolean;
}

export interface GmailIdTokenVerifier {
  verify(
    idToken: string,
    expected: {
      readonly clientId: string;
      readonly nonce: string;
    },
    signal: AbortSignal,
  ): Promise<GmailIdentity>;
}

export interface GmailOAuthTokenClient {
  exchange(
    input: {
      readonly code: string;
      readonly codeVerifier: string;
      readonly config: GmailOAuthConfig;
    },
    signal: AbortSignal,
  ): Promise<GoogleTokenGrant>;
}

export interface GoogleTokenGrant {
  readonly accessToken: Buffer;
  readonly refreshToken: Buffer;
  readonly expiresInSeconds: number;
  readonly idToken: string;
  readonly scopes: readonly string[];
}

interface EncodedTransaction {
  readonly version: 1;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export class InMemoryGmailOAuthTransactionStore
  implements GmailOAuthTransactionStore
{
  private readonly pending = new Map<string, number>();

  constructor(private readonly maxPending = 64) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1_024) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
  }

  issue(transactionId: string, expiresAt: number, now: number): void {
    validateTransactionId(transactionId);
    assertSafeTimestamp(expiresAt);
    assertSafeTimestamp(now);
    this.prune(now);
    if (expiresAt <= now || this.pending.size >= this.maxPending) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    if (this.pending.has(transactionId)) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    this.pending.set(transactionId, expiresAt);
  }

  consume(transactionId: string, now: number): boolean {
    validateTransactionId(transactionId);
    assertSafeTimestamp(now);
    const expiresAt = this.pending.get(transactionId);
    if (expiresAt === undefined) return false;
    this.pending.delete(transactionId);
    return expiresAt > now;
  }

  private prune(now: number): void {
    for (const [transactionId, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(transactionId);
    }
  }
}

export class GmailOAuthTransactionCodec {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    this.key = Buffer.from(key);
  }

  seal(transaction: GmailOAuthTransaction): string {
    validateTransaction(transaction);
    let plaintext: Buffer | null = null;
    let iv: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let tag: Buffer | null = null;
    try {
      plaintext = Buffer.from(JSON.stringify(transaction), "utf8");
      iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(TRANSACTION_AAD);
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      tag = cipher.getAuthTag();
      const encoded: EncodedTransaction = Object.freeze({
        version: TRANSACTION_VERSION,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      });
      return Buffer.from(JSON.stringify(encoded), "utf8").toString("base64url");
    } finally {
      plaintext?.fill(0);
      iv?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  open(value: string, now: number): GmailOAuthTransaction {
    assertSafeTimestamp(now);
    let serialized: Buffer | null = null;
    let iv: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    let tag: Buffer | null = null;
    let plaintext: Buffer | null = null;
    try {
      serialized = decodeCanonicalBase64Url(value, { maxBytes: 4 * 1024 });
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized.toString("utf8"));
      } catch {
        throw new GmailOAuthError("gmail_oauth_state_invalid");
      }
      const encoded = validateEncodedTransaction(parsed);
      iv = decodeCanonicalBase64Url(encoded.iv, { exactBytes: 12 });
      tag = decodeCanonicalBase64Url(encoded.tag, { exactBytes: 16 });
      ciphertext = decodeCanonicalBase64Url(encoded.ciphertext, {
        maxBytes: 2 * 1024,
      });
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(TRANSACTION_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      let transaction: unknown;
      try {
        transaction = JSON.parse(plaintext.toString("utf8"));
      } catch {
        throw new GmailOAuthError("gmail_oauth_state_invalid");
      }
      const validated = validateTransaction(transaction);
      if (validated.expiresAt <= now || validated.issuedAt > now + 30_000) {
        throw new GmailOAuthError("gmail_oauth_state_invalid");
      }
      return validated;
    } catch (error) {
      if (error instanceof GmailOAuthError) throw error;
      throw new GmailOAuthError("gmail_oauth_state_invalid");
    } finally {
      serialized?.fill(0);
      iv?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
      plaintext?.fill(0);
    }
  }
}

export class GoogleGmailOAuthTokenClient implements GmailOAuthTokenClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async exchange(
    input: {
      readonly code: string;
      readonly codeVerifier: string;
      readonly config: GmailOAuthConfig;
    },
    signal: AbortSignal,
  ): Promise<GoogleTokenGrant> {
    validateAuthorizationCode(input.code);
    validateCodeVerifier(input.codeVerifier);
    const body = new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.config.redirectUri,
    });
    let response: Response;
    try {
      response = await this.request(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      throw new GmailOAuthError("gmail_oauth_provider_error");
    }
    if (!response.ok || !isJsonContentType(response.headers.get("Content-Type"))) {
      await discardBoundedBody(response).catch(() => undefined);
      throw new GmailOAuthError("gmail_oauth_provider_error");
    }
    const payload = await readBoundedJson(response);
    return validateTokenGrant(payload, this.now());
  }
}

export class GoogleGmailIdTokenVerifier implements GmailIdTokenVerifier {
  async verify(
    idToken: string,
    expected: { readonly clientId: string; readonly nonce: string },
    signal: AbortSignal,
  ): Promise<GmailIdentity> {
    signal.throwIfAborted();
    if (!isSafeToken(idToken)) {
      throw new GmailOAuthError("gmail_oauth_identity_invalid");
    }
    try {
      const verified = await jwtVerify(idToken, GOOGLE_JWKS, {
        algorithms: ["RS256"],
        audience: expected.clientId,
        issuer: [...GOOGLE_ISSUERS],
        clockTolerance: 5,
      });
      signal.throwIfAborted();
      return validateGoogleIdentityClaims(verified.payload, expected);
    } catch (error) {
      if (error instanceof GmailOAuthError) throw error;
      throw new GmailOAuthError("gmail_oauth_identity_invalid");
    }
  }
}

export class GmailOAuthFlow {
  constructor(
    readonly config: GmailOAuthConfig,
    private readonly transactionCodec: GmailOAuthTransactionCodec,
    private readonly transactionStore: GmailOAuthTransactionStore,
    private readonly tokenClient: GmailOAuthTokenClient,
    private readonly idTokenVerifier: GmailIdTokenVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  start(targetAccountId: string | null = null): GmailOAuthAuthorization {
    validateTargetAccountId(targetAccountId, "gmail_oauth_request_invalid");
    const now = this.now();
    assertSafeTimestamp(now);
    const transaction = Object.freeze({
      version: TRANSACTION_VERSION,
      transactionId: randomBytes(24).toString("base64url"),
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      codeVerifier: randomBytes(64).toString("base64url"),
      issuedAt: now,
      expiresAt: now + TRANSACTION_TTL_MS,
      targetAccountId,
    }) satisfies GmailOAuthTransaction;
    this.transactionStore.issue(
      transaction.transactionId,
      transaction.expiresAt,
      now,
    );
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set(
      "code_challenge",
      createHash("sha256")
        .update(transaction.codeVerifier, "ascii")
        .digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("nonce", transaction.nonce);
    authorizationUrl.searchParams.set("prompt", "consent select_account");
    authorizationUrl.searchParams.set("redirect_uri", this.config.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", GMAIL_OAUTH_SCOPES.join(" "));
    authorizationUrl.searchParams.set("state", transaction.state);
    return Object.freeze({
      authorizationUrl: authorizationUrl.toString(),
      transactionCookieValue: this.transactionCodec.seal(transaction),
      expiresAt: transaction.expiresAt,
    });
  }

  async complete(
    callbackUrl: string,
    transactionCookieValue: string,
    signal: AbortSignal,
  ): Promise<GmailOAuthCompletion> {
    const now = this.now();
    assertSafeTimestamp(now);
    const transaction = this.transactionCodec.open(transactionCookieValue, now);
    const callback = validateCallbackUrl(callbackUrl, this.config.redirectUri);
    const returnedState = readSingleQueryValue(callback.searchParams, "state");
    if (!safeEqual(transaction.state, returnedState)) {
      throw new GmailOAuthError("gmail_oauth_state_invalid");
    }
    if (!this.transactionStore.consume(transaction.transactionId, now)) {
      throw new GmailOAuthError("gmail_oauth_state_invalid");
    }

    const providerError = readOptionalSingleQueryValue(
      callback.searchParams,
      "error",
    );
    if (providerError !== null) {
      if (providerError === "access_denied") {
        throw new GmailOAuthError("gmail_oauth_provider_denied");
      }
      throw new GmailOAuthError("gmail_oauth_provider_error");
    }
    const code = readSingleQueryValue(callback.searchParams, "code");
    validateAuthorizationCode(code);

    const tokenGrant = await this.tokenClient.exchange(
      {
        code,
        codeVerifier: transaction.codeVerifier,
        config: this.config,
      },
      signal,
    );
    try {
      validateExactScopes(tokenGrant.scopes);
      const identity = await this.idTokenVerifier.verify(
        tokenGrant.idToken,
        { clientId: this.config.clientId, nonce: transaction.nonce },
        signal,
      );
      return Object.freeze({
        grant: Object.freeze({
          provider: "gmail",
          subject: identity.subject,
          emailAddress: identity.emailAddress,
          scopes: GMAIL_OAUTH_SCOPES,
          accessToken: Buffer.from(tokenGrant.accessToken),
          refreshToken: Buffer.from(tokenGrant.refreshToken),
          accessTokenExpiresAt: now + tokenGrant.expiresInSeconds * 1_000,
          grantedAt: now,
        }),
        targetAccountId: transaction.targetAccountId,
      });
    } finally {
      tokenGrant.accessToken.fill(0);
      tokenGrant.refreshToken.fill(0);
    }
  }
}

export function readGmailOAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
  clientSecretCredential: Buffer,
): GmailOAuthConfig {
  const clientId = requireClientId(environment.GMAIL_OAUTH_CLIENT_ID);
  const clientSecret = decodeClientSecretCredential(clientSecretCredential);
  const publicOrigin = requireExactOrigin(environment.BRAIN_PUBLIC_ORIGIN);
  return Object.freeze({
    clientId,
    clientSecret,
    publicOrigin,
    redirectUri: `${publicOrigin}/api/mail/oauth/google/callback`,
  });
}

export function validateGoogleIdentityClaims(
  claims: JWTPayload,
  expected: { readonly clientId: string; readonly nonce: string },
): GmailIdentity {
  const audienceValid =
    claims.aud === expected.clientId ||
    (Array.isArray(claims.aud) &&
      claims.aud.includes(expected.clientId) &&
      claims.azp === expected.clientId);
  if (
    !GOOGLE_ISSUERS.includes(claims.iss ?? "") ||
    !audienceValid ||
    typeof claims.nonce !== "string" ||
    !safeEqual(claims.nonce, expected.nonce) ||
    typeof claims.sub !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) ||
    typeof claims.email !== "string" ||
    !isValidEmailAddress(claims.email) ||
    claims.email_verified !== true
  ) {
    throw new GmailOAuthError("gmail_oauth_identity_invalid");
  }
  return Object.freeze({
    subject: claims.sub,
    emailAddress: claims.email,
  });
}

export function destroyGmailOAuthGrant(grant: GmailOAuthGrant): void {
  grant.accessToken.fill(0);
  grant.refreshToken.fill(0);
}

function validateCallbackUrl(callbackUrl: string, expectedRedirectUri: string): URL {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(callbackUrl);
    expected = new URL(expectedRedirectUri);
  } catch {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    expected.search !== "" ||
    expected.hash !== "" ||
    callback.hash !== ""
  ) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  const allowed = new Set([
    "authuser",
    "code",
    "error",
    "error_description",
    "error_subtype",
    "hd",
    "iss",
    "prompt",
    "scope",
    "state",
  ]);
  for (const key of callback.searchParams.keys()) {
    if (!allowed.has(key) || callback.searchParams.getAll(key).length !== 1) {
      throw new GmailOAuthError("gmail_oauth_request_invalid");
    }
  }
  if (callback.searchParams.has("code") === callback.searchParams.has("error")) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  if (
    callback.searchParams.getAll("iss").length !== 1 ||
    callback.searchParams.get("iss") !== GOOGLE_AUTHORIZATION_RESPONSE_ISSUER
  ) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  return callback;
}

function validateTokenGrant(value: unknown, now: number): GoogleTokenGrant {
  assertSafeTimestamp(now);
  if (!isRecord(value)) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  if (
    value.token_type !== "Bearer" ||
    !isSafeToken(value.access_token) ||
    !isSafeToken(value.refresh_token) ||
    !isSafeToken(value.id_token) ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) < 1 ||
    (value.expires_in as number) > 86_400 ||
    typeof value.scope !== "string"
  ) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  const scopes = splitScopes(value.scope);
  validateExactScopes(scopes);
  return Object.freeze({
    accessToken: Buffer.from(value.access_token, "utf8"),
    refreshToken: Buffer.from(value.refresh_token, "utf8"),
    expiresInSeconds: value.expires_in as number,
    idToken: value.id_token,
    scopes,
  });
}

function validateExactScopes(scopes: readonly string[]): void {
  if (new Set(scopes).size !== scopes.length) {
    throw new GmailOAuthError("gmail_oauth_scope_invalid");
  }
  const canonical = new Set(
    scopes.map((scope) =>
      scope === GOOGLE_EMAIL_SCOPE_ALIAS ? "email" : scope,
    ),
  );
  if (
    canonical.size !== GMAIL_OAUTH_SCOPES.length ||
    GMAIL_OAUTH_SCOPES.some((scope) => !canonical.has(scope))
  ) {
    throw new GmailOAuthError("gmail_oauth_scope_invalid");
  }
}

function splitScopes(value: string): readonly string[] {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GmailOAuthError("gmail_oauth_scope_invalid");
  }
  const scopes = value.split(" ");
  if (scopes.some((scope) => scope.length === 0)) {
    throw new GmailOAuthError("gmail_oauth_scope_invalid");
  }
  return Object.freeze(scopes);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedBody(response);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  } finally {
    bytes.fill(0);
  }
}

async function discardBoundedBody(response: Response): Promise<void> {
  const body = await readBoundedBody(response);
  body.fill(0);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_TOKEN_RESPONSE_BYTES)
  ) {
    throw new GmailOAuthError("gmail_oauth_provider_error");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GmailOAuthError("gmail_oauth_provider_error");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new GmailOAuthError("gmail_oauth_provider_error");
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function validateEncodedTransaction(value: unknown): EncodedTransaction {
  if (
    !isExactRecord(value, ["version", "iv", "ciphertext", "tag"]) ||
    value.version !== TRANSACTION_VERSION ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string"
  ) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  return value as unknown as EncodedTransaction;
}

function validateTransaction(value: unknown): GmailOAuthTransaction {
  if (
    !isExactRecord(value, [
      "version",
      "transactionId",
      "state",
      "nonce",
      "codeVerifier",
      "issuedAt",
      "expiresAt",
      "targetAccountId",
    ]) ||
    value.version !== TRANSACTION_VERSION ||
    typeof value.transactionId !== "string" ||
    typeof value.state !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.codeVerifier !== "string" ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  validateTransactionId(value.transactionId);
  validateRandomBase64Url(value.state, 43);
  validateRandomBase64Url(value.nonce, 43);
  validateCodeVerifier(value.codeVerifier);
  validateTargetAccountId(value.targetAccountId, "gmail_oauth_state_invalid");
  const issuedAt = value.issuedAt as number;
  const expiresAt = value.expiresAt as number;
  if (
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt !== TRANSACTION_TTL_MS
  ) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  return Object.freeze({
    version: TRANSACTION_VERSION,
    transactionId: value.transactionId,
    state: value.state,
    nonce: value.nonce,
    codeVerifier: value.codeVerifier,
    issuedAt,
    expiresAt,
    targetAccountId: value.targetAccountId as string | null,
  });
}

function validateTargetAccountId(
  value: unknown,
  code: Extract<
    GmailOAuthErrorCode,
    "gmail_oauth_request_invalid" | "gmail_oauth_state_invalid"
  >,
): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !SAFE_ACCOUNT_ID.test(value))) {
    throw new GmailOAuthError(code);
  }
}

function readSingleQueryValue(parameters: URLSearchParams, key: string): string {
  const values = parameters.getAll(key);
  if (values.length !== 1 || values[0].length === 0 || values[0].length > 2_048) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  return values[0];
}

function readOptionalSingleQueryValue(
  parameters: URLSearchParams,
  key: string,
): string | null {
  if (!parameters.has(key)) return null;
  return readSingleQueryValue(parameters, key);
}

function validateAuthorizationCode(value: string): void {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_AUTHORIZATION_CODE_BYTES ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
}

function validateCodeVerifier(value: string): void {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
}

function validateTransactionId(value: string): void {
  validateRandomBase64Url(value, 32);
}

function validateRandomBase64Url(value: string, length: number): void {
  if (value.length !== length || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
}

function requireClientId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value)
  ) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return value;
}

function decodeClientSecretCredential(value: Buffer): string {
  if (
    !Buffer.isBuffer(value) ||
    value.length === 0 ||
    value.length > 4 * 1024
  ) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  const decoded = value.toString("utf8");
  if (
    Buffer.from(decoded, "utf8").compare(value) !== 0 ||
    /[\u0000\r\n]/.test(decoded)
  ) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return decoded;
}

function requireExactOrigin(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    return value;
  } catch (error) {
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
}

function decodeCanonicalBase64Url(
  value: string,
  limit: { readonly exactBytes: number } | { readonly maxBytes: number },
): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error("invalid base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  const validLength =
    "exactBytes" in limit
      ? decoded.length === limit.exactBytes
      : decoded.length > 0 && decoded.length <= limit.maxBytes;
  if (!validLength || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new Error("invalid base64url");
  }
  return decoded;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return (
      leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function isSafeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= MAX_TOKEN_BYTES &&
    !/[\u0000\r\n]/.test(value)
  );
}

function isValidEmailAddress(value: string): boolean {
  return (
    Buffer.byteLength(value) <= 320 &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    /^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(value)
  );
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value);
}

function assertSafeTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
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
