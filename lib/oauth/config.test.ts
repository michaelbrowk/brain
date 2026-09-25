import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpResource, oauthIssuer } from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("oauthIssuer", () => {
  it("takes an exact https origin", () => {
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.com");
    expect(oauthIssuer()).toBe("https://brain.example.com");
    expect(mcpResource()).toBe("https://brain.example.com/api/mcp");
  });

  it.each([
    "http://brain.lan",
    "http://brain.local:3020",
    "http://192.168.1.10:3000",
    "http://127.0.0.1:3021",
    "http://localhost:3000",
    "http://[fe80::1]:3020",
  ])("takes plain http on the private origin %s", (origin) => {
    // A house install on a name a home router hands out had no MCP at all:
    // every tool, the discovery documents and the static bearer are behind
    // this one function, and it threw for anything that was not https. Nobody
    // is going to terminate TLS for brain.lan.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", origin);
    expect(oauthIssuer()).toBe(new URL(origin).origin);
  });

  it.each([
    "http://brain.example.com",
    "http://evil.example",
    "http://8.8.8.8",
    "https://brain.example.com/notes",
    "https://brain.example.com?x=1",
    "https://brain.example.com#x",
    "https://user@brain.example.com",
    "ftp://brain.example.com",
  ])("refuses %s", (origin) => {
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", origin);
    expect(() => oauthIssuer()).toThrow(
      "BRAIN_PUBLIC_ORIGIN must be an exact HTTPS origin",
    );
  });

  it("warns that the tokens are in the clear before answering", async () => {
    // A fresh module instance, because the warning is latched once per process
    // and the cases above have already spent this file's. What the latch does
    // is pinned in `lib/private-origin.test.ts`; what this asks is that the
    // issuer reaches it at all, which is the half a refactor drops in silence.
    vi.resetModules();
    const fresh = await import("./config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "http://brain.lan");
    expect(fresh.oauthIssuer()).toBe("http://brain.lan");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      "tokens travel unencrypted on your network",
    );
  });
});
