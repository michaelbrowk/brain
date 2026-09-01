import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_EDGE_SECRET_HEADER,
  OAUTH_EDGE_SOURCE_HEADER,
  trustedOAuthRateSource,
} from "./rate-source";

const secret = "a".repeat(64);

afterEach(() => vi.unstubAllEnvs());

describe("trusted OAuth rate source", () => {
  it("does not trust a public source header without authenticated edge proof", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BRAIN_EDGE_RATE_SECRET", secret);
    const forged = new Request("https://brain.example/oauth/register", {
      headers: { [OAUTH_EDGE_SOURCE_HEADER]: "203.0.113.10" },
    });

    expect(() => trustedOAuthRateSource(forged)).toThrow(/trusted edge/);
  });

  it("isolates authenticated IPv4 and IPv6 sources without exposing the address", () => {
    vi.stubEnv("BRAIN_EDGE_RATE_SECRET", secret);
    const headers = (source: string) => ({
      [OAUTH_EDGE_SECRET_HEADER]: secret,
      [OAUTH_EDGE_SOURCE_HEADER]: source,
    });
    const first = trustedOAuthRateSource(
      new Request("https://brain.example/oauth/token", {
        headers: headers("203.0.113.10"),
      }),
    );
    const second = trustedOAuthRateSource(
      new Request("https://brain.example/oauth/token", {
        headers: headers("2001:db8::10"),
      }),
    );

    expect(first).not.toBe(second);
    expect(first).not.toContain("203.0.113.10");
    expect(second).not.toContain("2001:db8::10");
  });

  it("uses an explicit development bucket only when no edge secret is configured", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BRAIN_EDGE_RATE_SECRET", "");
    expect(
      trustedOAuthRateSource(
        new Request("http://localhost/oauth/register", {
          headers: { [OAUTH_EDGE_SOURCE_HEADER]: "198.51.100.4" },
        }),
      ),
    ).toBe("development");
  });
});
