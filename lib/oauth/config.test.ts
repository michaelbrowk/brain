import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpResource, oauthIssuer } from "./config";
import { resetPlainHttpWarnForTests } from "@/lib/private-origin";

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

  it.each([
    ["a zone id, the shape somebody pastes out of ip addr", "http://[fe80::1%25eth0]"],
    ["a bracket left open", "http://[fd12:3456::1"],
    ["a value that is not a URL at all", "brain.lan"],
    ["a space in the host", "http://brain .lan"],
  ])("answers the same sentence for %s, not a raw parser error", (_name, origin) => {
    // `new URL` throws its own `TypeError: Invalid URL` for each of these, which
    // reached the owner as a stack rather than as the one line saying what the
    // variable wants. The docs now invite IPv6 origins, so the zone-id shape is
    // the one a self-hoster is most likely to paste.
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", origin);
    expect(() => oauthIssuer()).toThrow(
      "BRAIN_PUBLIC_ORIGIN must be an exact HTTPS origin",
    );
  });

  it("warns that the tokens are in the clear before answering", () => {
    // The latch is per process and the cases above have already spent this
    // file's, so it is reset here rather than worked around with a fresh module
    // instance. What the latch does is pinned in `lib/private-origin.test.ts`;
    // what this asks is that the issuer reaches it at all, which is the half a
    // refactor drops in silence.
    resetPlainHttpWarnForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "http://brain.lan");
    expect(oauthIssuer()).toBe("http://brain.lan");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      "tokens travel unencrypted on your network",
    );
  });
});
