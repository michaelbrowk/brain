import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  GmailOAuthError,
  GMAIL_OAUTH_SCOPES,
  type GmailOAuthGrant,
} from "./oauth";

const SCHEMA_VERSION = 1;
const MAX_ENVELOPE_BYTES = 48 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_CREDENTIAL_REF = /^credential-r[0-9a-f]{32}$/;

export interface GmailCredentialBinding {
  readonly accountId: string;
  readonly kind: "oauth_refresh";
  readonly credentialRef: string;
  readonly version: number;
}

export interface SealedGmailTokenEnvelope {
  readonly schemaVersion: 1;
  readonly encryption: {
    readonly algorithm: "aes-256-gcm";
    readonly iv: string;
    readonly ciphertext: string;
    readonly tag: string;
  };
}

export interface StoredGmailCredential {
  readonly credentialVersion: 1;
  readonly provider: "gmail";
  readonly subject: string;
  readonly emailAddress: string;
  readonly scopes: typeof GMAIL_OAUTH_SCOPES;
  /** The caller owns this buffer and must wipe it after use. */
  readonly refreshToken: Buffer;
  readonly grantedAt: number;
}

interface PlaintextGmailTokenEnvelope {
  readonly credentialVersion: 1;
  readonly provider: "gmail";
  readonly subject: string;
  readonly emailAddress: string;
  readonly scopes: typeof GMAIL_OAUTH_SCOPES;
  readonly refreshToken: string;
  readonly grantedAt: number;
}

export function sealGmailTokenEnvelope(
  grant: GmailOAuthGrant,
  wrappingKey: Buffer,
  binding: GmailCredentialBinding,
): SealedGmailTokenEnvelope {
  validateGrant(grant);
  const key = copyWrappingKey(wrappingKey);
  const aad = createAad(binding);
  let plaintext: Buffer | null = null;
  let iv: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  let tag: Buffer | null = null;
  try {
    const value: PlaintextGmailTokenEnvelope = Object.freeze({
      credentialVersion: 1,
      provider: "gmail",
      subject: grant.subject,
      emailAddress: grant.emailAddress,
      scopes: GMAIL_OAUTH_SCOPES,
      refreshToken: grant.refreshToken.toString("base64url"),
      grantedAt: grant.grantedAt,
    });
    plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.length === 0 || plaintext.length > MAX_ENVELOPE_BYTES) {
      throw new GmailOAuthError("gmail_oauth_token_invalid");
    }
    iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      encryption: Object.freeze({
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      }),
    });
  } finally {
    key.fill(0);
    aad.fill(0);
    plaintext?.fill(0);
    iv?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
  }
}

export function openGmailTokenEnvelope(
  envelope: unknown,
  wrappingKey: Buffer,
  binding: GmailCredentialBinding,
): StoredGmailCredential {
  const validated = validateSealedEnvelope(envelope);
  const key = copyWrappingKey(wrappingKey);
  const aad = createAad(binding);
  let iv: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  let tag: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    iv = decodeCanonicalBase64Url(validated.encryption.iv, {
      exactBytes: 12,
    });
    tag = decodeCanonicalBase64Url(validated.encryption.tag, {
      exactBytes: 16,
    });
    ciphertext = decodeCanonicalBase64Url(validated.encryption.ciphertext, {
      maxBytes: MAX_ENVELOPE_BYTES,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (plaintext.length === 0 || plaintext.length > MAX_ENVELOPE_BYTES) {
      throw new GmailOAuthError("gmail_oauth_token_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new GmailOAuthError("gmail_oauth_token_invalid");
    }
    return validatePlaintextEnvelope(parsed);
  } catch (error) {
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  } finally {
    key.fill(0);
    aad.fill(0);
    iv?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
    plaintext?.fill(0);
  }
}

export function validateSealedGmailTokenEnvelope(
  value: unknown,
): SealedGmailTokenEnvelope {
  return validateSealedEnvelope(value);
}

function validateSealedEnvelope(value: unknown): SealedGmailTokenEnvelope {
  if (
    !isExactRecord(value, ["schemaVersion", "encryption"]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isExactRecord(value.encryption, [
      "algorithm",
      "iv",
      "ciphertext",
      "tag",
    ]) ||
    value.encryption.algorithm !== "aes-256-gcm" ||
    typeof value.encryption.iv !== "string" ||
    typeof value.encryption.ciphertext !== "string" ||
    typeof value.encryption.tag !== "string"
  ) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  const buffers: Buffer[] = [];
  try {
    buffers.push(
      decodeCanonicalBase64Url(value.encryption.iv, { exactBytes: 12 }),
    );
    buffers.push(
      decodeCanonicalBase64Url(value.encryption.tag, { exactBytes: 16 }),
    );
    buffers.push(
      decodeCanonicalBase64Url(value.encryption.ciphertext, {
        maxBytes: MAX_ENVELOPE_BYTES,
      }),
    );
  } finally {
    for (const buffer of buffers) buffer.fill(0);
  }
  return value as unknown as SealedGmailTokenEnvelope;
}

export function destroyStoredGmailCredential(
  credential: StoredGmailCredential,
): void {
  credential.refreshToken.fill(0);
}

function validatePlaintextEnvelope(value: unknown): StoredGmailCredential {
  if (
    !isExactRecord(value, [
      "credentialVersion",
      "provider",
      "subject",
      "emailAddress",
      "scopes",
      "refreshToken",
      "grantedAt",
    ]) ||
    value.credentialVersion !== 1 ||
    value.provider !== "gmail" ||
    !hasExactScopes(value.scopes) ||
    typeof value.subject !== "string" ||
    typeof value.emailAddress !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.grantedAt !== "number"
  ) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  let refreshToken: Buffer | null = null;
  try {
    refreshToken = decodeCanonicalBase64Url(value.refreshToken, {
      maxBytes: MAX_TOKEN_BYTES,
    });
    if (
      !/^[A-Za-z0-9_-]{1,255}$/.test(value.subject) ||
      !isValidEmailAddress(value.emailAddress) ||
      !Number.isSafeInteger(value.grantedAt) ||
      value.grantedAt < 0 ||
      !isSafeTokenBuffer(refreshToken)
    ) {
      throw new GmailOAuthError("gmail_oauth_token_invalid");
    }
    const credential: StoredGmailCredential = Object.freeze({
      credentialVersion: 1,
      provider: "gmail",
      subject: value.subject,
      emailAddress: value.emailAddress,
      scopes: GMAIL_OAUTH_SCOPES,
      refreshToken,
      grantedAt: value.grantedAt,
    });
    refreshToken = null;
    return credential;
  } catch (error) {
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  } finally {
    refreshToken?.fill(0);
  }
}

function validateGrant(grant: GmailOAuthGrant): void {
  if (
    grant.provider !== "gmail" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(grant.subject) ||
    !isValidEmailAddress(grant.emailAddress) ||
    grant.scopes.length !== GMAIL_OAUTH_SCOPES.length ||
    GMAIL_OAUTH_SCOPES.some((scope, index) => grant.scopes[index] !== scope) ||
    !isSafeTokenBuffer(grant.accessToken) ||
    !isSafeTokenBuffer(grant.refreshToken) ||
    !Number.isSafeInteger(grant.grantedAt) ||
    grant.grantedAt < 0 ||
    !Number.isSafeInteger(grant.accessTokenExpiresAt) ||
    grant.accessTokenExpiresAt <= grant.grantedAt ||
    grant.accessTokenExpiresAt - grant.grantedAt > 86_400_000
  ) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
}

function copyWrappingKey(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return Buffer.from(value);
}

function createAad(binding: GmailCredentialBinding): Buffer {
  if (
    !SAFE_ACCOUNT_ID.test(binding.accountId) ||
    binding.kind !== "oauth_refresh" ||
    !SAFE_CREDENTIAL_REF.test(binding.credentialRef) ||
    !Number.isSafeInteger(binding.version) ||
    binding.version < 1
  ) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  return Buffer.from(
    `brain-mail:gmail-token:v1:${binding.accountId}:${binding.kind}:${binding.credentialRef}:v${binding.version}`,
    "utf8",
  );
}

function isSafeTokenBuffer(value: Buffer): boolean {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_TOKEN_BYTES) {
    return false;
  }
  for (const byte of value) {
    if (byte === 0 || byte === 10 || byte === 13) return false;
  }
  return true;
}

function isValidEmailAddress(value: string): boolean {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 320 &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    /^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(value)
  );
}

function hasExactScopes(value: unknown): value is typeof GMAIL_OAUTH_SCOPES {
  return (
    Array.isArray(value) &&
    value.length === GMAIL_OAUTH_SCOPES.length &&
    GMAIL_OAUTH_SCOPES.every((scope, index) => value[index] === scope)
  );
}

function decodeCanonicalBase64Url(
  value: string,
  limit: { readonly exactBytes: number } | { readonly maxBytes: number },
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  const validLength =
    "exactBytes" in limit
      ? decoded.length === limit.exactBytes
      : decoded.length > 0 && decoded.length <= limit.maxBytes;
  if (!validLength || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new GmailOAuthError("gmail_oauth_token_invalid");
  }
  return decoded;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
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
