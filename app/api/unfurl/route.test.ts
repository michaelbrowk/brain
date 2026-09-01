import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";

// The SSRF guard in this route had zero regression coverage (audit
// 2026-08-19): isPrivateIPv4/IPv6, the DNS pre-resolution check, and the
// per-hop redirect recheck were all unverified. These tests pin the guard
// through the public handler with DNS and fetch mocked out.

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);
const fetchMock = vi.fn();

function request(target: string): NextRequest {
  return new NextRequest(
    `https://brain.example/api/unfurl?url=${encodeURIComponent(target)}`,
  );
}

async function unfurl(target: string) {
  const { GET } = await import("./route");
  const response = await GET(request(target));
  return (await response.json()) as { title: string; description?: string };
}

describe("unfurl SSRF guard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    lookupMock.mockReset();
    vi.unstubAllGlobals();
    // the module caches results per URL — a fresh module isolates each test
    vi.resetModules();
  });

  it("refuses literal private and special-use addresses without any network activity", async () => {
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/admin",
      "http://10.0.0.7/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/",
      "http://intranet/",
    ]) {
      const data = await unfurl(target);
      expect(data.description).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses URLs with credentials or a non-http protocol without fetching", async () => {
    for (const target of [
      "http://user:secret@example.com/",
      "ftp://example.com/file",
      "file:///etc/passwd",
      "gopher://example.com/",
    ]) {
      await unfurl(target);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks a public-looking hostname whose DNS answer is private (rebinding)", async () => {
    lookupMock.mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never);

    await unfurl("http://rebind-attack.example.com/");

    expect(lookupMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks every redirect hop and blocks one that lands on a private host", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    fetchMock.mockResolvedValue({
      status: 302,
      ok: false,
      headers: new Headers({ location: "http://127.0.0.1/admin" }),
    });

    await unfurl("http://redirects-inward.example.com/");

    // one fetch for the public first hop, none for the blocked private hop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an unresolvable hostname as blocked", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));

    await unfurl("http://does-not-resolve.example.com/");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
