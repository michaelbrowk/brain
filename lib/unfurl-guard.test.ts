import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { Buffer } from "node:buffer";

// The guard chain moved here verbatim from app/api/unfurl/route.ts (it also
// protects the sender-icon proxy). These tests pin the functions directly;
// the unfurl route keeps its own end-to-end SSRF tests through GET.

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

import {
  hostResolvesPrivate,
  isBlockedHost,
  isPrivateIPv4,
  isPrivateIPv6,
  readCappedBytes,
  safeHttpUrl,
} from "./unfurl-guard";

afterEach(() => {
  lookupMock.mockReset();
});

describe("isPrivateIPv4", () => {
  it("flags every private and special-use range, passes public addresses", () => {
    for (const host of [
      "0.0.0.0",
      "10.0.0.7",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "999.1.1.1", // out-of-range octet is treated as unsafe, not public
    ]) {
      expect(isPrivateIPv4(host), host).toBe(true);
    }
    expect(isPrivateIPv4("93.184.216.34")).toBe(false);
    expect(isPrivateIPv4("example.com")).toBe(false); // not an IPv4 literal
  });
});

describe("isPrivateIPv6", () => {
  it("flags loopback, link-local, ULA, and both IPv4-mapped spellings", () => {
    for (const host of [
      "::",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // dotted mapped form
      "::ffff:7f00:1", // hex mapped form (audit 2026-08-19)
      "::ffff:c0a8:101", // hex-mapped 192.168.1.1
    ]) {
      expect(isPrivateIPv6(host), host).toBe(true);
    }
    expect(isPrivateIPv6("2606:4700::1")).toBe(false);
    expect(isPrivateIPv6("::ffff:5db8:d822")).toBe(false); // mapped 93.184.216.34
  });
});

describe("isBlockedHost", () => {
  it("blocks localhost, single-label hosts, and private literals", () => {
    for (const host of [
      "",
      "localhost",
      "sub.localhost",
      "intranet",
      "10.0.0.7",
      "127.0.0.1.",
      "[::1]",
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("example.com.")).toBe(false); // trailing dot normalized
  });
});

describe("hostResolvesPrivate", () => {
  it("short-circuits private literals without touching DNS", async () => {
    expect(await hostResolvesPrivate("127.0.0.1")).toBe(true);
    expect(await hostResolvesPrivate("[::1]")).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("flags a public-looking name whose DNS answer is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ] as never);
    expect(await hostResolvesPrivate("rebind.example.com")).toBe(true);
  });

  it("passes a name resolving only to public addresses", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ] as never);
    expect(await hostResolvesPrivate("example.com")).toBe(false);
  });

  it("treats an unresolvable name as private", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await hostResolvesPrivate("does-not-resolve.example.com")).toBe(true);
  });
});

describe("safeHttpUrl", () => {
  it("rejects non-http schemes, credentials, and blocked hosts", () => {
    expect(safeHttpUrl("ftp://example.com/file")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("gopher://example.com/")).toBeNull();
    expect(safeHttpUrl("http://user:secret@example.com/")).toBeNull();
    expect(safeHttpUrl("http://127.0.0.1/admin")).toBeNull();
    expect(safeHttpUrl("http://localhost/")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("accepts public http(s) URLs and resolves relative locations", () => {
    expect(safeHttpUrl("https://example.com/favicon.ico")?.href).toBe(
      "https://example.com/favicon.ico",
    );
    expect(safeHttpUrl("/icon.png", "https://example.com/a/b")?.href).toBe(
      "https://example.com/icon.png",
    );
    // A relative location must not escape to a blocked absolute target.
    expect(safeHttpUrl("http://127.0.0.1/x", "https://example.com/")).toBeNull();
  });
});

describe("readCappedBytes", () => {
  it("returns the full body when it fits the cap", async () => {
    const body = Buffer.from("abcdefgh");
    const bytes = await readCappedBytes(new Response(new Uint8Array(body)), 64);
    expect(bytes.equals(body)).toBe(true);
  });

  it("stops at maxBytes + 1 so callers can detect an over-cap stream", async () => {
    const body = new Uint8Array(1024).fill(7);
    const bytes = await readCappedBytes(new Response(body), 100);
    expect(bytes.byteLength).toBe(101);
  });

  it("returns an empty buffer for a bodyless response", async () => {
    const bytes = await readCappedBytes(new Response(null, { status: 204 }), 64);
    expect(bytes.byteLength).toBe(0);
  });
});
