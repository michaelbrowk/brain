import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPrivateNetworkHost,
  resetPlainHttpWarnForTests,
  warnPlainHttpOriginOnce,
} from "./private-origin";

/** The host as a URL sees it, which is the only shape this predicate is ever
 *  asked about: the parser lowercases it, strips a trailing dot, normalises a
 *  dotted quad written in octal, and keeps an IPv6 literal in its brackets. A
 *  test that passed the raw string instead would be testing a shape no caller
 *  can produce. */
const hostOf = (origin: string) => new URL(origin).hostname;

describe("isPrivateNetworkHost", () => {
  it.each([
    ["http://localhost:3000", "the name every dev server answers on"],
    ["http://127.0.0.1:3020", "loopback"],
    ["http://127.1.2.3", "the rest of 127.0.0.0/8, which is also loopback"],
    ["http://[::1]:3000", "loopback over IPv6"],
    ["http://10.0.0.1", "RFC 1918, ten"],
    ["http://172.16.4.5", "RFC 1918, the bottom of the 172 block"],
    ["http://172.31.255.254", "RFC 1918, the top of the 172 block"],
    ["http://192.168.1.10:3000", "RFC 1918, the home router's own block"],
    ["http://169.254.7.7", "IPv4 link-local"],
    ["http://[fe80::1]", "IPv6 link-local"],
    ["http://[fd12:3456:789a::1]", "an IPv6 unique local address"],
    ["http://[fc00::1]", "the bottom of fc00::/7"],
    ["http://brain.local", "the name Bonjour hands out"],
    ["http://brain.lan", "the name a home router hands out"],
    ["http://brain.home.arpa", "the name RFC 8375 reserves for it"],
    ["http://notes.internal", "the name a private zone uses"],
  ])("takes %s (%s)", (origin) => {
    expect(isPrivateNetworkHost(hostOf(origin))).toBe(true);
  });

  it.each([
    ["http://evil.example", "a public name"],
    ["http://brain.example.com", "a real host somebody owns"],
    ["http://8.8.8.8", "a public address"],
    ["http://172.15.0.1", "just below the 172 block"],
    ["http://172.32.0.1", "just above the 172 block"],
    ["http://192.167.1.1", "one octet off the home block"],
    ["http://11.0.0.1", "one octet off the ten block"],
    ["http://169.253.1.1", "one octet off link-local"],
    ["http://0.0.0.0", "the unspecified address, which is not loopback"],
    ["http://[2001:db8::1]", "a global IPv6 address"],
    ["http://[fec0::1]", "site-local, deprecated and not link-local"],
    // IPv4-mapped IPv6, all three of them. The parser rewrites the quad into
    // hex, so `::ffff:8.8.8.8` arrives as `[::ffff:808:808]`: a rule that read
    // the `::ffff:` prefix as "this is really IPv4, go and read the quad" would
    // hand plain http to a public address. None of the three is accepted, the
    // loopback one included — `127.0.0.1` is right there to write instead.
    ["http://[::ffff:8.8.8.8]", "a public address as IPv4-mapped IPv6"],
    ["http://[::ffff:7f00:1]", "loopback as IPv4-mapped IPv6"],
    ["http://[::ffff:192.168.0.1]", "a private address as IPv4-mapped IPv6"],
    ["http://localhost.evil.example", "a public name wearing the word"],
    ["http://brain.lan.evil.example", "a public name ending in something else"],
    ["http://internal", "a bare label, which is not a private zone"],
    ["http://local", "the suffix on its own"],
  ])("refuses %s (%s)", (origin) => {
    expect(isPrivateNetworkHost(hostOf(origin))).toBe(false);
  });

  it("refuses a suffix that is the whole host", () => {
    // The one live input for the length guard beside the suffix check. The two
    // bare labels above never reach it, because `"local".endsWith(".local")` is
    // already false; `new URL("http://.local").hostname` is `".local"`, which
    // ends with the suffix and is nothing in front of it.
    expect(isPrivateNetworkHost(".local")).toBe(false);
    expect(isPrivateNetworkHost(".lan")).toBe(false);
    expect(isPrivateNetworkHost(".home.arpa")).toBe(false);
    expect(isPrivateNetworkHost(".internal")).toBe(false);
  });

  it("reads the suffixes without regard to case", () => {
    expect(isPrivateNetworkHost("BRAIN.LAN")).toBe(true);
    expect(isPrivateNetworkHost("Brain.Home.Arpa")).toBe(true);
  });
});

describe("warnPlainHttpOriginOnce", () => {
  // The latch is per process, so a second case in this file would have read the
  // first one's leftovers. Reset it rather than rely on the order.
  beforeEach(() => {
    resetPlainHttpWarnForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPlainHttpWarnForTests();
  });

  it("says it once, with the cost spelled out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnPlainHttpOriginOnce("http://brain.lan");
    warnPlainHttpOriginOnce("http://brain.lan");
    warnPlainHttpOriginOnce("http://192.168.1.10:3000");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      "tokens travel unencrypted on your network",
    );
  });

  it("names the origin it is serving, so a log line says which install", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnPlainHttpOriginOnce("http://192.168.1.10:3000");
    expect(String(warn.mock.calls[0]![0])).toContain("http://192.168.1.10:3000");
  });
});
