import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, createShareToken } from "@/lib/auth";
import { config, proxy } from "./proxy";

describe("proxy authentication boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "middleware-test-secret");
    vi.stubEnv("MCP_TOKEN", "machine-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a share token presented as the human session cookie", async () => {
    const share = await createShareToken("page-1", 1);
    const req = new NextRequest("https://brain.test/api/settings/mcp", {
      headers: { cookie: `brain_session=${share}` },
    });

    const res = await proxy(req);
    expect(res.status).toBe(401);
  });

  it("does not let the MCP bearer into ordinary APIs", async () => {
    const req = new NextRequest("https://brain.test/api/settings/backup", {
      headers: { authorization: "Bearer machine-token" },
    });

    const res = await proxy(req);
    expect(res.status).toBe(401);
  });

  it("keeps backup facts behind a human session", async () => {
    const session = await createSession();
    const anonymous = await proxy(
      new NextRequest("https://brain.test/api/settings/backup"),
    );
    const share = await createShareToken("page-1", 1);
    const shared = await proxy(
      new NextRequest("https://brain.test/api/settings/backup", {
        headers: { cookie: `brain_session=${share}` },
      }),
    );
    const owner = await proxy(
      new NextRequest("https://brain.test/api/settings/backup", {
        headers: { cookie: `brain_session=${session}` },
      }),
    );

    expect(anonymous.status).toBe(401);
    expect(shared.status).toBe(401);
    expect(owner.status).toBe(200);
  });

  it("keeps human and MCP credentials in their intended routes", async () => {
    const session = await createSession();
    const human = await proxy(
      new NextRequest("https://brain.test/api/tree", {
        headers: { cookie: `brain_session=${session}` },
      }),
    );
    const machine = await proxy(
      new NextRequest("https://brain.test/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer machine-token" },
      }),
    );

    expect(human.status).toBe(200);
    expect(machine.status).toBe(200);
  });

  it("leaves the MCP bearer boundary to the exported route wrapper", async () => {
    const session = await createSession();
    const anonymous = await proxy(
      new NextRequest("https://brain.test/api/mcp", { method: "POST" }),
    );
    const humanOnly = await proxy(
      new NextRequest("https://brain.test/api/mcp", {
        method: "POST",
        headers: { cookie: `brain_session=${session}` },
      }),
    );
    const machine = await proxy(
      new NextRequest("https://brain.test/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer machine-token" },
      }),
    );

    expect(anonymous.status).toBe(200);
    expect(humanOnly.status).toBe(200);
    expect(machine.status).toBe(200);
  });

  it("keeps the Notion binary upload behind the same MCP bearer boundary", async () => {
    const anonymous = await proxy(
      new NextRequest("https://brain.test/api/mcp/notion-upload", {
        method: "POST",
      }),
    );
    const machine = await proxy(
      new NextRequest("https://brain.test/api/mcp/notion-upload", {
        method: "POST",
        headers: { authorization: "Bearer machine-token" },
      }),
    );

    expect(anonymous.status).toBe(200);
    expect(machine.status).toBe(200);
  });

  it("keeps sender icons behind a human session", async () => {
    // The favicon proxy performs outbound fetches keyed by attacker-suppliable
    // domains — it must never join a public allowlist.
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://brain.test/api/mail/sender-icon/example.com",
      }),
    ).toBe(true);

    const anonymous = await proxy(
      new NextRequest("https://brain.test/api/mail/sender-icon/example.com"),
    );
    expect(anonymous.status).toBe(401);
  });

  it("exposes only GET on the health endpoint", async () => {
    const get = await proxy(
      new NextRequest("https://brain.test/api/health"),
    );
    const post = await proxy(
      new NextRequest("https://brain.test/api/health", { method: "POST" }),
    );

    expect(get.status).toBe(200);
    expect(post.status).toBe(401);
  });

  it("never treats an extension-like page id as a public asset", async () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://brain.test/api/page/private.png",
      }),
    ).toBe(true);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://brain.test/p/private.svg",
      }),
    ).toBe(true);

    const api = await proxy(
      new NextRequest("https://brain.test/api/page/private.png", {
        method: "PUT",
      }),
    );
    const page = await proxy(
      new NextRequest("https://brain.test/p/private.svg"),
    );

    expect(api.status).toBe(401);
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://brain.test/login");
  });

  it("opens exact public assets but not arbitrary files with the same extension", async () => {
    const logo = await proxy(
      new NextRequest("https://brain.test/logo.png"),
    );
    const font = await proxy(
      new NextRequest("https://brain.test/fonts/brain-current/inter.woff2"),
    );
    const arbitrary = await proxy(
      new NextRequest("https://brain.test/private.png"),
    );
    const arbitraryFont = await proxy(
      new NextRequest("https://brain.test/private.woff2"),
    );

    expect(logo.status).toBe(200);
    expect(font.status).toBe(200);
    expect(arbitrary.status).toBe(307);
    expect(arbitrary.headers.get("location")).toBe("https://brain.test/login");
    expect(arbitraryFont.status).toBe(307);
    expect(arbitraryFont.headers.get("location")).toBe(
      "https://brain.test/login",
    );
  });
});
