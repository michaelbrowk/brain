import crypto from "node:crypto";
import type { withMcpAuth } from "mcp-handler";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { isOwnerSubject, OWNER_SUBJECT, verifyMcpToken } from "@/lib/auth";
import {
  MCP_SCOPES,
  type McpScope,
  mcpResource,
  normalizeScopes,
  ownerEffectiveScopes,
  oauthIssuer,
  OAuthRequestError,
} from "./config";
import {
  getOAuthStateStore,
  type OAuthClient,
  type OAuthGrant,
  type RefreshCredential,
} from "./state";

const ACCESS_TOKEN_SECONDS = 15 * 60;
const REQUEST_TOKEN_SECONDS = 10 * 60;
const ACCESS_KIND = "oauth_access";
const REQUEST_KIND = "oauth_authorization_request";
const REFRESH_KIND = "oauth_refresh";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_IN_FLIGHT_CODE_EXCHANGES = 512;
const MAX_IN_FLIGHT_REFRESH_EXCHANGES = 512;

type AuthInfo = Exclude<
  Awaited<ReturnType<Parameters<typeof withMcpAuth>[1]>>,
  undefined
>;

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(8),
  grant_types: z.array(z.string()).max(4).optional(),
  response_types: z.array(z.string()).max(4).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  application_type: z.enum(["native", "web"]).optional(),
}).passthrough();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  scopes: McpScope[];
  resource: string;
  codeChallenge: string;
  state?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface VerifiedAuthorizationRequest
  extends Omit<AuthorizationRequest, "clientName" | "redirectHost"> {
  requestId: string;
  requestExpiresAt: number;
}

interface InFlightRefreshExchange {
  fingerprint: string;
  promise: Promise<OAuthTokenResponse>;
}

const inFlightCodeExchanges = new Map<string, InFlightRefreshExchange>();
const inFlightRefreshExchanges = new Map<string, InFlightRefreshExchange>();

function rawAuthSecret(): Buffer {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 32) {
    throw new Error("AUTH_SECRET must contain at least 256 bits");
  }
  return bytes;
}

function signingKey(domain: "access" | "request" | "refresh"): Uint8Array {
  return new Uint8Array(
    crypto.hkdfSync(
      "sha256",
      rawAuthSecret(),
      Buffer.from("brain:oauth:v2", "utf8"),
      Buffer.from(domain, "utf8"),
      32,
    ),
  );
}

function splitScopes(value: string | null): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function requireValue(
  values: URLSearchParams,
  name: string,
  maxLength = 2_048,
): string {
  const all = values.getAll(name);
  if (all.length !== 1 || !all[0] || all[0].length > maxLength) {
    throw new OAuthRequestError("invalid_request", `Invalid ${name}`);
  }
  return all[0];
}

function assertExactResource(resource: string): void {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new OAuthRequestError("invalid_target", "Invalid resource");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString() !== mcpResource()
  ) {
    throw new OAuthRequestError("invalid_target", "Invalid resource");
  }
}

export function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthRequestError("invalid_request", "Invalid redirect URI");
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new OAuthRequestError("invalid_request", "Invalid redirect URI");
  }
  return value;
}

export async function registerOAuthClient(
  input: unknown,
): Promise<OAuthClient> {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) {
    throw new OAuthRequestError("invalid_request", "Invalid client metadata");
  }
  const grantTypes = parsed.data.grant_types ?? [
    "authorization_code",
    "refresh_token",
  ];
  if (
    grantTypes.some(
      (value) => value !== "authorization_code" && value !== "refresh_token",
    ) ||
    !grantTypes.includes("authorization_code")
  ) {
    throw new OAuthRequestError("invalid_request", "Unsupported grant type");
  }
  const responseTypes = parsed.data.response_types ?? ["code"];
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    throw new OAuthRequestError("invalid_request", "Unsupported response type");
  }
  const redirectUris = parsed.data.redirect_uris.map(validateRedirectUri);
  if (new Set(redirectUris).size !== redirectUris.length) {
    throw new OAuthRequestError("invalid_request", "Duplicate redirect URI");
  }
  return getOAuthStateStore().registerClient({
    name: parsed.data.client_name,
    redirectUris,
    applicationType: parsed.data.application_type ??
      (redirectUris.every((uri) => isLoopbackHostname(new URL(uri).hostname))
        ? "native"
        : "web"),
  });
}

export async function parseAuthorizationRequest(
  values: URLSearchParams,
): Promise<AuthorizationRequest> {
  if (requireValue(values, "response_type", 32) !== "code") {
    throw new OAuthRequestError(
      "unsupported_response_type",
      "Only authorization code is supported",
    );
  }
  const clientId = requireValue(values, "client_id");
  const client = await getOAuthStateStore().getClient(clientId);
  if (!client) throw new OAuthRequestError("invalid_client", "Unknown client");
  const redirectUri = requireValue(values, "redirect_uri");
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthRequestError("invalid_request", "Redirect URI mismatch");
  }
  const resource = requireValue(values, "resource");
  assertExactResource(resource);
  const method = requireValue(values, "code_challenge_method", 16);
  const codeChallenge = requireValue(values, "code_challenge", 128);
  if (method !== "S256" || !PKCE_CHALLENGE.test(codeChallenge)) {
    throw new OAuthRequestError("invalid_request", "PKCE S256 is required");
  }
  const scopes = normalizeScopes(splitScopes(values.get("scope")));
  const stateValues = values.getAll("state");
  if (stateValues.length > 1 || (stateValues[0]?.length ?? 0) > 1_024) {
    throw new OAuthRequestError("invalid_request", "Invalid state");
  }
  return {
    clientId,
    clientName: client.name,
    redirectUri,
    redirectHost: new URL(redirectUri).host,
    scopes,
    resource,
    codeChallenge,
    ...(stateValues[0] ? { state: stateValues[0] } : {}),
  };
}

export async function createAuthorizationRequestToken(
  request: AuthorizationRequest,
): Promise<string> {
  return new SignJWT({
    kind: REQUEST_KIND,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    resource: request.resource,
    codeChallenge: request.codeChallenge,
    ...(request.state ? { state: request.state } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("brain")
    .setAudience("brain:oauth:authorize")
    .setSubject(OWNER_SUBJECT)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${REQUEST_TOKEN_SECONDS}s`)
    .sign(signingKey("request"));
}

export async function verifyAuthorizationRequestToken(
  token: string,
): Promise<VerifiedAuthorizationRequest> {
  try {
    const { payload } = await jwtVerify(token, signingKey("request"), {
      algorithms: ["HS256"],
      issuer: "brain",
      audience: "brain:oauth:authorize",
    });
    if (
      !isOwnerSubject(payload.sub) ||
      payload.kind !== REQUEST_KIND ||
      typeof payload.clientId !== "string" ||
      typeof payload.redirectUri !== "string" ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.every((scope) => typeof scope === "string") ||
      typeof payload.resource !== "string" ||
      typeof payload.codeChallenge !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.state !== undefined && typeof payload.state !== "string")
    ) {
      throw new Error("invalid request token");
    }
    const scopes = normalizeScopes(payload.scopes);
    assertExactResource(payload.resource);
    if (!PKCE_CHALLENGE.test(payload.codeChallenge)) {
      throw new Error("invalid challenge");
    }
    return {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      scopes,
      resource: payload.resource,
      codeChallenge: payload.codeChallenge,
      requestId: payload.jti,
      requestExpiresAt: payload.exp * 1_000,
      ...(payload.state ? { state: payload.state } : {}),
    };
  } catch {
    throw new OAuthRequestError("invalid_request", "Invalid connection request");
  }
}

export async function approveAuthorizationRequest(
  requestToken: string,
): Promise<URL> {
  const request = await verifyAuthorizationRequestToken(requestToken);
  const client = await getOAuthStateStore().getClient(request.clientId);
  if (!client || !client.redirectUris.includes(request.redirectUri)) {
    throw new OAuthRequestError("invalid_client", "Client changed");
  }
  const code = await getOAuthStateStore().issueCode(request);
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("code", code);
  if (request.state) redirect.searchParams.set("state", request.state);
  return redirect;
}

export async function denyAuthorizationRequest(
  requestToken: string,
): Promise<URL> {
  const request = await verifyAuthorizationRequestToken(requestToken);
  const client = await getOAuthStateStore().getClient(request.clientId);
  if (!client || !client.redirectUris.includes(request.redirectUri)) {
    throw new OAuthRequestError("invalid_client", "Client changed");
  }
  await getOAuthStateStore().consumeConsentRequest(request);
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  if (request.state) redirect.searchParams.set("state", request.state);
  return redirect;
}

async function createAccessToken(
  grant: OAuthGrant,
  scopes: McpScope[] = grant.scopes,
): Promise<string> {
  return new SignJWT({
    kind: ACCESS_KIND,
    client_id: grant.clientId,
    scope: scopes.join(" "),
    gid: grant.id,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(oauthIssuer())
    .setAudience(grant.resource)
    .setSubject(OWNER_SUBJECT)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
    .sign(signingKey("access"));
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  scopes: McpScope[],
): OAuthTokenResponse {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

async function createRefreshToken(credential: RefreshCredential): Promise<string> {
  return new SignJWT({
    kind: REFRESH_KIND,
    client_id: credential.clientId,
    gid: credential.grantId,
    fid: credential.familyId,
    gen: credential.generation,
    nonce: credential.nonce,
    scope: credential.scopes.join(" "),
    resource: credential.resource,
    refresh_expires_at: credential.expiresAt,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(oauthIssuer())
    .setAudience(`${oauthIssuer()}/oauth/token`)
    .setSubject(OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(Math.floor(credential.expiresAt / 1_000))
    .sign(signingKey("refresh"));
}

async function verifyRefreshToken(
  token: string,
  expectedClientId: string,
): Promise<RefreshCredential> {
  const key = signingKey("refresh");
  const issuer = oauthIssuer();
  const audience = `${issuer}/oauth/token`;
  const expectedResource = mcpResource();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer,
      audience,
    });
    if (
      !isOwnerSubject(payload.sub) ||
      payload.kind !== REFRESH_KIND ||
      payload.client_id !== expectedClientId ||
      typeof payload.gid !== "string" ||
      typeof payload.fid !== "string" ||
      typeof payload.gen !== "number" ||
      !Number.isSafeInteger(payload.gen) ||
      payload.gen < 0 ||
      typeof payload.nonce !== "string" ||
      typeof payload.scope !== "string" ||
      typeof payload.resource !== "string" ||
      typeof payload.refresh_expires_at !== "number" ||
      !Number.isSafeInteger(payload.refresh_expires_at)
    ) {
      throw new Error("invalid refresh claims");
    }
    const scopes = normalizeScopes(splitScopes(payload.scope));
    if (payload.resource !== expectedResource) throw new Error("invalid resource");
    return {
      grantId: payload.gid,
      clientId: payload.client_id,
      familyId: payload.fid,
      generation: payload.gen,
      nonce: payload.nonce,
      scopes,
      resource: payload.resource,
      expiresAt: payload.refresh_expires_at,
    };
  } catch {
    throw new OAuthRequestError("invalid_grant", "Invalid refresh token");
  }
}

export async function exchangeOAuthToken(
  values: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const grantType = requireValue(values, "grant_type", 64);
  const clientId = requireValue(values, "client_id");
  const resource = requireValue(values, "resource");
  assertExactResource(resource);
  if (grantType === "authorization_code") {
    const code = requireValue(values, "code", 512);
    const redirectUri = requireValue(values, "redirect_uri");
    const codeVerifier = requireValue(values, "code_verifier", 128);
    if (!PKCE_VERIFIER.test(codeVerifier)) {
      throw new OAuthRequestError("invalid_grant", "Invalid code verifier");
    }
    return exchangeAuthorizationCodeOnce(
      code,
      clientId,
      redirectUri,
      resource,
      codeVerifier,
    );
  }
  if (grantType === "refresh_token") {
    const refreshToken = requireValue(values, "refresh_token", 2_048);
    const requested = values.has("scope")
      ? normalizeScopes(splitScopes(values.get("scope")))
      : undefined;
    return exchangeRefreshTokenOnce(
      refreshToken,
      clientId,
      resource,
      requested,
    );
  }
  throw new OAuthRequestError(
    "unsupported_grant_type",
    "Unsupported grant type",
  );
}

function exchangeAuthorizationCodeOnce(
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  const key = hashInFlightValue(code);
  const fingerprint = hashInFlightValue(
    JSON.stringify([clientId, redirectUri, resource, codeVerifier]),
  );
  const existing = inFlightCodeExchanges.get(key);
  if (existing?.fingerprint === fingerprint) return existing.promise;
  if (inFlightCodeExchanges.size >= MAX_IN_FLIGHT_CODE_EXCHANGES) {
    throw new Error("OAuth authorization code exchange capacity reached");
  }

  const exchange = performAuthorizationCodeExchange(
    code,
    clientId,
    redirectUri,
    resource,
    codeVerifier,
  );
  const holder: { promise?: Promise<OAuthTokenResponse> } = {};
  const tracked = exchange.finally(() => {
    if (inFlightCodeExchanges.get(key)?.promise === holder.promise) {
      inFlightCodeExchanges.delete(key);
    }
  });
  holder.promise = tracked;
  inFlightCodeExchanges.set(key, { fingerprint, promise: tracked });
  return tracked;
}

async function performAuthorizationCodeExchange(
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  const store = getOAuthStateStore();
  if ((await store.authorizationCodeDisposition(code)) === "unknown") {
    throw new OAuthRequestError("invalid_grant", "Invalid authorization code");
  }
  const result = await store.redeemCode({
    code,
    clientId,
    redirectUri,
    resource,
    codeVerifier,
  });
  return tokenResponse(
    await createAccessToken(result.grant),
    await createRefreshToken(result.refresh),
    result.grant.scopes,
  );
}

function exchangeRefreshTokenOnce(
  refreshToken: string,
  clientId: string,
  resource: string,
  requestedScopes: McpScope[] | undefined,
): Promise<OAuthTokenResponse> {
  const key = hashInFlightValue(refreshToken);
  const fingerprint = hashInFlightValue(
    JSON.stringify([clientId, resource, requestedScopes ?? null]),
  );
  const existing = inFlightRefreshExchanges.get(key);
  if (existing?.fingerprint === fingerprint) return existing.promise;
  if (inFlightRefreshExchanges.size >= MAX_IN_FLIGHT_REFRESH_EXCHANGES) {
    throw new Error("OAuth refresh exchange capacity reached");
  }

  const exchange = performRefreshExchange(
    refreshToken,
    clientId,
    requestedScopes,
  );
  const holder: { promise?: Promise<OAuthTokenResponse> } = {};
  const tracked = exchange.finally(() => {
    if (inFlightRefreshExchanges.get(key)?.promise === holder.promise) {
      inFlightRefreshExchanges.delete(key);
    }
  });
  holder.promise = tracked;
  inFlightRefreshExchanges.set(key, { fingerprint, promise: tracked });
  return tracked;
}

async function performRefreshExchange(
  refreshToken: string,
  clientId: string,
  requestedScopes: McpScope[] | undefined,
): Promise<OAuthTokenResponse> {
  const credential = await verifyRefreshToken(refreshToken, clientId);
  const result = await getOAuthStateStore().rotateRefreshToken({
    credential,
    requestedScopes,
  });
  const effectiveScopes = result.refresh.scopes;
  return tokenResponse(
    await createAccessToken(result.grant, effectiveScopes),
    await createRefreshToken(result.refresh),
    effectiveScopes,
  );
}

function hashInFlightValue(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

export async function verifyMcpBearerToken(
  token: string | undefined,
): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  if (verifyMcpToken(`Bearer ${token}`)) {
    return {
      token,
      clientId: "brain-legacy-bearer",
      scopes: [...MCP_SCOPES],
      resource: new URL(mcpResource()),
      extra: { legacy: true },
    };
  }
  try {
    const { payload } = await jwtVerify(token, signingKey("access"), {
      algorithms: ["HS256"],
      issuer: oauthIssuer(),
      audience: mcpResource(),
    });
    if (
      !isOwnerSubject(payload.sub) ||
      payload.kind !== ACCESS_KIND ||
      typeof payload.client_id !== "string" ||
      typeof payload.scope !== "string" ||
      typeof payload.gid !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return undefined;
    }
    const scopes = normalizeScopes(splitScopes(payload.scope));
    const active = await getOAuthStateStore().isGrantActive({
      grantId: payload.gid,
      clientId: payload.client_id,
      resource: mcpResource(),
      scopes,
    });
    if (!active) return undefined;
    return {
      token,
      clientId: payload.client_id,
      scopes: ownerEffectiveScopes(scopes),
      expiresAt: payload.exp,
      resource: new URL(mcpResource()),
      extra: { grantId: payload.gid },
    };
  } catch (error) {
    if (error instanceof OAuthRequestError) throw error;
    return undefined;
  }
}

export async function revokeOAuthToken(
  token: string,
  clientId: string,
): Promise<void> {
  let refresh: RefreshCredential | null = null;
  try {
    refresh = await verifyRefreshToken(token, clientId);
  } catch (error) {
    if (!(error instanceof OAuthRequestError)) throw error;
    // The same endpoint accepts access and refresh tokens without disclosing type.
  }
  if (refresh) {
    await getOAuthStateStore().revokeRefreshCredential(refresh);
  }

  const accessKey = signingKey("access");
  const issuer = oauthIssuer();
  const resource = mcpResource();
  let accessGrantId: string | null = null;
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      algorithms: ["HS256"],
      issuer,
      audience: resource,
    });
    if (
      isOwnerSubject(payload.sub) &&
      payload.kind === ACCESS_KIND &&
      payload.client_id === clientId &&
      typeof payload.gid === "string"
    ) {
      accessGrantId = payload.gid;
    }
  } catch {
    // RFC 7009 deliberately does not reveal whether the token was valid.
  }
  if (accessGrantId) {
    await getOAuthStateStore().revokeGrant(accessGrantId);
  }
}

export function authorizationServerMetadata() {
  const issuer = oauthIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}
