import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_EDGE_SECRET_HEADER,
  OAUTH_EDGE_SOURCE_HEADER,
} from "@/lib/oauth/rate-source";

const mocks = vi.hoisted(() => ({
  exchangeOAuthToken: vi.fn(),
  registerOAuthClient: vi.fn(),
  revokeOAuthToken: vi.fn(),
}));

vi.mock("@/lib/oauth/server", () => mocks);

import { POST as register } from "./register/route";
import { POST as revoke } from "./revoke/route";
import { POST as token } from "./token/route";

const edgeSecret = "a".repeat(64);

describe("OAuth public route isolation", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BRAIN_EDGE_RATE_SECRET", edgeSecret);
    mocks.registerOAuthClient.mockReset();
    mocks.registerOAuthClient.mockImplementation(async (input: { client_name: string }) => ({
      id: `brain_client_${input.client_name.replace(/\W/g, "x").padEnd(24, "x")}`,
      name: input.client_name,
      redirectUris: ["https://client.example/callback"],
      applicationType: "web",
      createdAt: Date.now(),
    }));
    mocks.exchangeOAuthToken.mockReset();
    mocks.exchangeOAuthToken.mockResolvedValue({
      access_token: "access",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: "refresh",
      scope: "brain:read",
    });
    mocks.revokeOAuthToken.mockReset();
    mocks.revokeOAuthToken.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects direct-origin registration without authenticated edge proof", async () => {
    const response = await register(registrationRequest("Direct", undefined));

    expect(response.status).toBe(503);
    expect(mocks.registerOAuthClient).not.toHaveBeenCalled();
  });

  it("does not let one source exhaust the registration bucket for another", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (await register(registrationRequest(`Source A ${attempt}`, "203.0.113.10"))).status,
      ).toBe(201);
    }
    expect(
      (await register(registrationRequest("Blocked A", "203.0.113.10"))).status,
    ).toBe(429);
    expect(
      (await register(registrationRequest("Source B", "203.0.113.11"))).status,
    ).toBe(201);
  });

  it("returns OAuth invalid_request for malformed DCR JSON", async () => {
    const response = await register(
      new Request("https://brain.example/oauth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...trustedHeaders("203.0.113.70"),
        },
        body: '{"client_name":',
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
      error_description: "Request body must be valid JSON",
    });
    expect(mocks.registerOAuthClient).not.toHaveBeenCalled();
  });

  it("isolates token attempts by both authenticated source and client", async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      expect((await token(tokenRequest("client-a", "198.51.100.1"))).status).toBe(200);
    }
    expect((await token(tokenRequest("client-a", "198.51.100.1"))).status).toBe(429);
    expect((await token(tokenRequest("client-b", "198.51.100.1"))).status).toBe(200);
    expect((await token(tokenRequest("client-a", "198.51.100.2"))).status).toBe(200);
  });

  it("stops one source rotating client_id values at the aggregate limit", async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      expect(
        (await token(tokenRequest(`rotating-client-${attempt}`, "198.51.100.50")))
          .status,
      ).toBe(200);
    }

    expect(
      (await token(tokenRequest("rotating-client-blocked", "198.51.100.50")))
        .status,
    ).toBe(429);
    expect(
      (await token(tokenRequest("other-source", "198.51.100.51"))).status,
    ).toBe(200);
  });

  it("returns server_error when durable revocation of a recognized token fails", async () => {
    mocks.revokeOAuthToken.mockRejectedValueOnce(
      new Error("simulated OAuth state persistence failure"),
    );

    const response = await revoke(revokeRequest("client-a", "198.51.100.60"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "server_error",
      error_description: "OAuth is temporarily unavailable",
    });
  });
});

function trustedHeaders(source: string): Record<string, string> {
  return {
    [OAUTH_EDGE_SECRET_HEADER]: edgeSecret,
    [OAUTH_EDGE_SOURCE_HEADER]: source,
  };
}

function registrationRequest(name: string, source?: string): Request {
  return new Request("https://brain.example/oauth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(source ? trustedHeaders(source) : {}),
    },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
}

function tokenRequest(clientId: string, source: string): Request {
  return new Request("https://brain.example/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...trustedHeaders(source),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: "refresh",
      resource: "https://brain.example/api/mcp",
    }),
  });
}

function revokeRequest(clientId: string, source: string): Request {
  return new Request("https://brain.example/oauth/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...trustedHeaders(source),
    },
    body: new URLSearchParams({
      client_id: clientId,
      token: "recognized-valid-token",
    }),
  });
}
