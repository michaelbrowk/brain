import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReleaseInfo } from "@/lib/release-info";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn<() => Promise<void>>(),
  oauthReadiness: vi.fn<() => Promise<void>>(),
  searchReady: vi.fn<() => Promise<void>>(),
  getStore: vi.fn(),
  getOAuthStateStore: vi.fn(),
  readReleaseInfo: vi.fn<() => Promise<ReleaseInfo>>(),
}));

vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/search", () => ({ assertSearchReady: mocks.searchReady }));
vi.mock("@/lib/oauth/state", () => ({
  getOAuthStateStore: mocks.getOAuthStateStore,
}));
vi.mock("@/lib/release-info", () => ({
  readReleaseInfo: mocks.readReleaseInfo,
}));

import { GET } from "./route";

function request(deep = false, authorized = deep): NextRequest {
  return new NextRequest(
    `http://127.0.0.1:3020/api/health${deep ? "?ready=1" : ""}`,
    authorized
      ? { headers: { "x-brain-readiness": "a".repeat(64) } }
      : undefined,
  );
}

function configureRuntime(): void {
  vi.stubEnv("NOTES_ROOT", "/opt/brain/notes");
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
  vi.stubEnv("AUTH_PASSWORD_HASH", `$2b$12$${"a".repeat(53)}`);
  vi.stubEnv("MCP_TOKEN", "test-mcp-token");
  vi.stubEnv("BRAIN_READINESS_TOKEN", "a".repeat(64));
  vi.stubEnv("BRAIN_EDGE_RATE_SECRET", "b".repeat(64));
  vi.stubEnv("BRAIN_OAUTH_STATE_DIR", "/var/lib/brain/oauth");
}

describe("health route", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.readiness.mockReset().mockResolvedValue(undefined);
    mocks.oauthReadiness.mockReset().mockResolvedValue(undefined);
    mocks.searchReady.mockReset().mockResolvedValue(undefined);
    mocks.getStore.mockReset().mockResolvedValue({
      root: "/opt/brain/notes",
      readiness: mocks.readiness,
    });
    mocks.getOAuthStateStore.mockReset().mockReturnValue({
      readiness: mocks.oauthReadiness,
    });
    mocks.readReleaseInfo.mockReset().mockResolvedValue({
      version: null,
      commit: "unknown",
      buildTime: null,
    });
  });

  it("keeps the shallow liveness probe cheap", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
    expect(body.version).toBeNull();
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("reports the release version when release.json is present", async () => {
    mocks.readReleaseInfo.mockResolvedValueOnce({
      version: "0.9.0",
      commit: "c".repeat(40),
      buildTime: "2026-09-01T18:00:00Z",
    });

    const body = await (await GET(request())).json();

    expect(body.version).toBe("0.9.0");
  });

  it("checks configured auth, MCP, Git-backed store, and writes when ready=1", async () => {
    configureRuntime();

    const response = await GET(request(true));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
    expect(mocks.readiness).toHaveBeenCalledOnce();
    expect(mocks.oauthReadiness).toHaveBeenCalledOnce();
    expect(mocks.searchReady).toHaveBeenCalledOnce();
  });

  it("rejects an anonymous deep probe before touching the store", async () => {
    configureRuntime();

    const response = await GET(request(true, false));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      status: "unauthorized",
      version: null,
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.searchReady).not.toHaveBeenCalled();
    expect(mocks.oauthReadiness).not.toHaveBeenCalled();
  });

  it("returns a generic 503 without exposing configuration details", async () => {
    configureRuntime();
    vi.stubEnv("MCP_TOKEN", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({ status: "unready" });
      expect(JSON.stringify(body)).not.toContain("MCP_TOKEN");
      expect(mocks.getStore).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["AUTH_SECRET", "too-short"],
    ["BRAIN_EDGE_RATE_SECRET", "not-hex"],
    ["BRAIN_OAUTH_STATE_DIR", "relative/oauth"],
  ])("is unready for invalid OAuth runtime setting %s", async (name, value) => {
    configureRuntime();
    vi.stubEnv(name, value);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));

      expect(response.status).toBe(503);
      expect(mocks.getStore).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("is unready when the notes store cannot complete its probe", async () => {
    configureRuntime();
    mocks.readiness.mockRejectedValueOnce(new Error("private path details"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(JSON.stringify(body)).not.toContain("private path details");
    } finally {
      log.mockRestore();
    }
  });

  it("distinguishes Store initialization from the subsequent readiness probe", async () => {
    configureRuntime();
    mocks.getStore.mockRejectedValueOnce(new Error("private initialization details"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "unready",
        check: "notes_store_init",
        commit: "unknown",
        builtAt: "unknown",
        version: null,
      });
      expect(mocks.readiness).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("is unready when ripgrep is unavailable", async () => {
    configureRuntime();
    mocks.searchReady.mockRejectedValueOnce(new Error("spawn rg ENOENT"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({ status: "unready" });
      expect(JSON.stringify(body)).not.toContain("spawn rg ENOENT");
      expect(mocks.getStore).not.toHaveBeenCalled();
      expect(mocks.oauthReadiness).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("reports a safe actionable check when OAuth state permissions are insecure", async () => {
    configureRuntime();
    mocks.oauthReadiness.mockRejectedValueOnce(
      new Error("OAuth state file /private/secret/state.json has mode 0644"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await GET(request(true));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        status: "unready",
        check: "oauth_state",
        commit: "unknown",
        builtAt: "unknown",
        version: null,
      });
      expect(JSON.stringify(body)).not.toContain("/private/secret");
      expect(JSON.stringify(body)).not.toContain("0644");
      expect(mocks.getStore).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
