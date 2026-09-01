import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_OWNER_SUBJECT } from "@/lib/auth";
import {
  approveAuthorizationRequest,
  createAuthorizationRequestToken,
  denyAuthorizationRequest,
  exchangeOAuthToken,
  parseAuthorizationRequest,
  registerOAuthClient,
  revokeOAuthToken,
  verifyMcpBearerToken,
} from "./server";

describe("Brain MCP OAuth server", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "brain-oauth-server-"));
    vi.stubEnv("AUTH_SECRET", "oauth-test-secret-with-enough-entropy");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example");
    vi.stubEnv("BRAIN_OAUTH_STATE_DIR", path.join(directory, "oauth"));
    vi.stubEnv("MCP_TOKEN", "legacy-machine-token");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("requires exact redirect, resource, and PKCE S256", async () => {
    const client = await clientRegistration();
    const valid = authorizationParams(client.id, "read-verifier".padEnd(43, "x"));

    await expect(
      parseAuthorizationRequest(
        new URLSearchParams({
          ...Object.fromEntries(valid),
          redirect_uri: "https://evil.example/callback",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      parseAuthorizationRequest(
        new URLSearchParams({
          ...Object.fromEntries(valid),
          resource: "https://brain.example/api/other",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await expect(
      parseAuthorizationRequest(
        new URLSearchParams({
          ...Object.fromEntries(valid),
          code_challenge_method: "plain",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("accepts standard DCR metadata, classifies loopback clients, and rejects insecure redirects", async () => {
    const client = await registerOAuthClient({
      client_name: "Local MCP client",
      client_uri: "https://client.example",
      logo_uri: "https://client.example/logo.png",
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      token_endpoint_auth_method: "none",
    });

    expect(client.applicationType).toBe("native");
    await expect(
      registerOAuthClient({
        client_name: "Insecure remote client",
        redirect_uris: ["http://client.example/callback"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("keeps an in-flight grant issued to the subject's old name", async () => {
    // jose enforces `subject` by equality, so accepting the retired name meant
    // checking it by hand at each verify site. This re-signs a genuine request
    // token under the old subject and drives the real approval path with it.
    const { SignJWT, decodeJwt } = await import("jose");
    const key = new Uint8Array(
      crypto.hkdfSync(
        "sha256",
        Buffer.from("oauth-test-secret-with-enough-entropy", "utf8"),
        Buffer.from("brain:oauth:v2", "utf8"),
        Buffer.from("request", "utf8"),
        32,
      ),
    );
    const client = await clientRegistration();
    const verifier = "legacy-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const decoded = decodeJwt(await createAuthorizationRequestToken(request));
    const { iss, aud, exp, iat, jti } = decoded;
    const claims = { ...decoded } as Record<string, unknown>;
    for (const registered of ["sub", "iss", "aud", "exp", "iat", "jti"]) {
      delete claims[registered];
    }
    const reissued = (subject: string) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(String(iss))
        .setAudience(String(aud))
        .setSubject(subject)
        .setJti(String(jti))
        .setIssuedAt(iat)
        .setExpirationTime(exp!)
        .sign(key);

    const approved = await approveAuthorizationRequest(await reissued(LEGACY_OWNER_SUBJECT));
    expect(approved.searchParams.get("code")).toBeTruthy();
    // And only the retired name — not any subject at all.
    await expect(approveAuthorizationRequest(await reissued("someone"))).rejects.toThrow();
  });

  it("completes code exchange, rejects replay, and binds access to audience", async () => {
    const client = await clientRegistration();
    const verifier = "oauth-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const requestToken = await createAuthorizationRequestToken(request);
    const redirect = await approveAuthorizationRequest(requestToken);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.id,
      code: code!,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: "https://brain.example/api/mcp",
    });
    const token = await exchangeOAuthToken(form);
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toMatchObject({
      clientId: client.id,
      scopes: ["brain:read"],
      resource: new URL("https://brain.example/api/mcp"),
    });
    await expect(exchangeOAuthToken(form)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toBeUndefined();
    await expect(
      exchangeOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.id,
          refresh_token: token.refresh_token,
          resource: "https://brain.example/api/mcp",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      exchangeOAuthToken(
        new URLSearchParams({
          ...Object.fromEntries(form),
          resource: "https://brain.example/api/other",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("retires a narrower grant after the same client redeems an approved scope upgrade", async () => {
    const client = await clientRegistration();
    const exchange = async (verifier: string, scope: string) => {
      const request = await parseAuthorizationRequest(
        authorizationParams(client.id, verifier, scope),
      );
      const redirect = await approveAuthorizationRequest(
        await createAuthorizationRequestToken(request),
      );
      return exchangeOAuthToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.id,
          code: redirect.searchParams.get("code")!,
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          resource: "https://brain.example/api/mcp",
        }),
      );
    };
    const oldToken = await exchange(
      "narrow-grant-verifier".padEnd(43, "x"),
      "brain:read brain:write",
    );
    const upgradedToken = await exchange(
      "import-grant-verifier".padEnd(43, "x"),
      "brain:import",
    );

    await expect(verifyMcpBearerToken(oldToken.access_token)).resolves.toBeUndefined();
    await expect(verifyMcpBearerToken(upgradedToken.access_token)).resolves.toMatchObject({
      clientId: client.id,
      scopes: ["brain:read", "brain:write", "brain:import"],
    });
  });

  it("treats an existing owner write grant as the full owner API", async () => {
    const client = await clientRegistration();
    const verifier = "owner-write-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier, "brain:read brain:write"),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );

    expect(token.scope).toBe("brain:read brain:write");
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toMatchObject({
      clientId: client.id,
      scopes: ["brain:read", "brain:write", "brain:import"],
    });
  });

  it("consumes one signed consent request atomically across concurrent approvals", async () => {
    const client = await clientRegistration();
    const verifier = "one-time-consent-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const requestToken = await createAuthorizationRequestToken(request);

    const approvals = await Promise.allSettled([
      approveAuthorizationRequest(requestToken),
      approveAuthorizationRequest(requestToken),
    ]);
    const fulfilled = approvals.filter(
      (result): result is PromiseFulfilledResult<URL> =>
        result.status === "fulfilled",
    );
    const rejected = approvals.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "invalid_request",
      message: "Connection request already used",
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, "oauth", "state.json"), "utf8"),
    ) as {
      grants: Record<string, unknown>;
      codes: Record<string, unknown>;
    };
    expect(Object.keys(persisted.grants)).toHaveLength(1);
    expect(Object.keys(persisted.codes)).toHaveLength(1);

    await expect(
      exchangeOAuthToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.id,
          code: fulfilled[0]!.value.searchParams.get("code")!,
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          resource: "https://brain.example/api/mcp",
        }),
      ),
    ).resolves.toMatchObject({ token_type: "Bearer" });
  });

  it("does not allow a denied consent request to be approved later", async () => {
    const client = await clientRegistration();
    const verifier = "denied-consent-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const requestToken = await createAuthorizationRequestToken(request);

    const denial = await denyAuthorizationRequest(requestToken);
    expect(denial.searchParams.get("error")).toBe("access_denied");
    await expect(
      approveAuthorizationRequest(requestToken),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Connection request already used",
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, "oauth", "state.json"), "utf8"),
    ) as { grants: Record<string, unknown>; codes: Record<string, unknown> };
    expect(Object.keys(persisted.grants)).toHaveLength(0);
    expect(Object.keys(persisted.codes)).toHaveLength(0);
  });

  it("coalesces an exact concurrent code exchange without weakening later replay detection", async () => {
    const client = await clientRegistration();
    const verifier = "concurrent-code-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const code = redirect.searchParams.get("code")!;
    const codeForm = () =>
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      });

    const [first, duplicate] = await Promise.all([
      exchangeOAuthToken(codeForm()),
      exchangeOAuthToken(codeForm()),
    ]);

    expect(duplicate).toEqual(first);
    await expect(verifyMcpBearerToken(first.access_token)).resolves.toMatchObject({
      clientId: client.id,
    });

    await expect(exchangeOAuthToken(codeForm())).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await expect(verifyMcpBearerToken(first.access_token)).resolves.toBeUndefined();
  });

  it("coalesces an exact concurrent refresh without weakening later replay detection", async () => {
    const client = await clientRegistration();
    const verifier = "concurrent-refresh-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const initial = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );
    const refreshForm = () =>
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.id,
        refresh_token: initial.refresh_token,
        resource: "https://brain.example/api/mcp",
      });

    const [first, duplicate] = await Promise.all([
      exchangeOAuthToken(refreshForm()),
      exchangeOAuthToken(refreshForm()),
    ]);

    expect(duplicate).toEqual(first);
    await expect(verifyMcpBearerToken(first.access_token)).resolves.toMatchObject({
      clientId: client.id,
    });

    const next = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.id,
        refresh_token: first.refresh_token,
        resource: "https://brain.example/api/mcp",
      }),
    );
    await expect(verifyMcpBearerToken(next.access_token)).resolves.toMatchObject({
      clientId: client.id,
    });

    await expect(exchangeOAuthToken(refreshForm())).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await expect(verifyMcpBearerToken(next.access_token)).resolves.toBeUndefined();
  });

  it("rejects an unknown authorization code without rewriting OAuth state", async () => {
    const client = await clientRegistration();
    const open = vi.spyOn(fs, "open");
    const rename = vi.spyOn(fs, "rename");
    try {
      await expect(
        exchangeOAuthToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.id,
            code: "unknown-authorization-code",
            redirect_uri: "https://client.example/callback",
            code_verifier: "unknown-code-verifier".padEnd(43, "x"),
            resource: "https://brain.example/api/mcp",
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(open).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      rename.mockRestore();
    }
  });

  it("rejects an expired access token and accepts the legacy bearer during migration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:00:00Z"));
    const client = await clientRegistration();
    const verifier = "expiry-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );
    vi.advanceTimersByTime(16 * 60_000);

    await expect(verifyMcpBearerToken(token.access_token)).resolves.toBeUndefined();
    await expect(verifyMcpBearerToken("legacy-machine-token")).resolves.toMatchObject({
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:write", "brain:import"],
    });
  });

  it("revokes an access token and its refresh grant without revealing token validity", async () => {
    const client = await clientRegistration();
    const verifier = "revocation-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );

    await revokeOAuthToken(token.access_token, client.id);
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toBeUndefined();
    await expect(
      exchangeOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.id,
          refresh_token: token.refresh_token,
          resource: "https://brain.example/api/mcp",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      revokeOAuthToken("unknown-token", client.id),
    ).resolves.toBeUndefined();
  });

  it("does not report a valid token revoked when durable state persistence fails", async () => {
    const client = await clientRegistration();
    const verifier = "revoke-persistence-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("simulated OAuth state fsync failure"), {
        code: "EIO",
      }),
    );
    try {
      await expect(
        revokeOAuthToken(token.access_token, client.id),
      ).rejects.toThrow("simulated OAuth state fsync failure");
    } finally {
      rename.mockRestore();
    }

    await expect(verifyMcpBearerToken(token.access_token)).resolves.toMatchObject({
      clientId: client.id,
    });
    await expect(
      revokeOAuthToken(token.access_token, client.id),
    ).resolves.toBeUndefined();
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toBeUndefined();
    await expect(
      revokeOAuthToken("unknown-token", client.id),
    ).resolves.toBeUndefined();
  });

  it("does not report a valid token revoked when signing configuration is unavailable", async () => {
    const client = await clientRegistration();
    const verifier = "revoke-config-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );

    vi.stubEnv("AUTH_SECRET", "");
    await expect(
      revokeOAuthToken(token.access_token, client.id),
    ).rejects.toThrow("AUTH_SECRET is not set");

    vi.stubEnv("AUTH_SECRET", "oauth-test-secret-with-enough-entropy");
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toMatchObject({
      clientId: client.id,
    });
    await expect(
      revokeOAuthToken(token.access_token, client.id),
    ).resolves.toBeUndefined();
    await expect(verifyMcpBearerToken(token.access_token)).resolves.toBeUndefined();
  });

  it("persists refresh downscope and rejects escalation without consuming the token", async () => {
    const client = await clientRegistration();
    const verifier = "refresh-scope-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier, "brain:read brain:write"),
    );
    const redirect = await approveAuthorizationRequest(
      await createAuthorizationRequestToken(request),
    );
    const token = await exchangeOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://brain.example/api/mcp",
      }),
    );
    const refresh = (refreshToken: string, scope?: string) =>
      exchangeOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.id,
          refresh_token: refreshToken,
          resource: "https://brain.example/api/mcp",
          ...(scope ? { scope } : {}),
        }),
      );

    const downscoped = await refresh(token.refresh_token, "brain:read");
    expect(downscoped.scope).toBe("brain:read");
    await expect(refresh(downscoped.refresh_token, "brain:write")).rejects.toMatchObject({
      code: "invalid_scope",
    });
    await expect(refresh(downscoped.refresh_token)).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "brain:read",
    });
  });

  it("uses domain-separated tokens and rejects an AUTH_SECRET shorter than 256 bits", async () => {
    const client = await clientRegistration();
    const verifier = "domain-verifier".padEnd(43, "x");
    const request = await parseAuthorizationRequest(
      authorizationParams(client.id, verifier),
    );
    const requestToken = await createAuthorizationRequestToken(request);

    await expect(verifyMcpBearerToken(requestToken)).resolves.toBeUndefined();

    vi.stubEnv("AUTH_SECRET", "too-short");
    await expect(createAuthorizationRequestToken(request)).rejects.toThrow(
      "AUTH_SECRET must contain at least 256 bits",
    );
  });
});

async function clientRegistration() {
  return registerOAuthClient({
    client_name: "Test MCP client",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  });
}

function authorizationParams(
  clientId: string,
  verifier: string,
  scope = "brain:read",
) {
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    scope,
    state: "opaque-client-state",
    resource: "https://brain.example/api/mcp",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
}
