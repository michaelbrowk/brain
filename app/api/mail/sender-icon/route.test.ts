import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

// The sender-icon proxy is the mail surface's only egress path from the Next
// app. These tests pin the full 11-step pipeline — syntax, SSRF guards,
// redirect re-vetting, size cap, magic-byte sniffing, disk cache, and the
// single-flight map — with DNS and fetch mocked out.

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);
const fetchMock = vi.fn();

const PUBLIC_A = [{ address: "93.184.216.34", family: 4 }];
const PRIVATE_A = [{ address: "10.0.0.7", family: 4 }];

const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = Buffer.from("<!doctype html><html><body>404</body></html>");

function testPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function imageResponse(bytes: Buffer, contentType = "application/octet-stream") {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function redirectResponse(location: string) {
  return {
    status: 302,
    ok: false,
    headers: new Headers({ location }),
  } as Response;
}

describe("sender-icon proxy", () => {
  let directory: string;

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sender-icon-route-"));
    vi.stubEnv("BRAIN_SENDER_ICON_DIR", directory);
  });

  afterEach(async () => {
    fetchMock.mockReset();
    lookupMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // the single-flight map is module state — a fresh module isolates tests
    vi.resetModules();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function requestIcon(domain: string) {
    const { GET } = await import("./[domain]/route");
    return GET(
      new Request(
        `https://brain.example/api/mail/sender-icon/${encodeURIComponent(domain)}`,
      ),
      { params: Promise.resolve({ domain }) },
    );
  }

  it("normalizes case and a trailing dot, then fetches the https favicon", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(ICO));

    const res = await requestIcon("EXAMPLE.COM.");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.com/favicon.ico");
  });

  it("rejects malformed domains without any DNS or network activity", async () => {
    for (const domain of [
      "1.2.3.4", // dotted IPv4 → all-numeric TLD
      "10.0.0.7", // private literal, also all-numeric TLD
      "intranet", // single label
      `${"a".repeat(250)}.com`, // 254 chars
      "-bad.com", // leading hyphen label
      "bad-.com", // trailing hyphen label
      "foo_bar.com", // underscore is not LDH
      "[::1]", // IPv6 literal
      "fe80::1", // colon form
      "example..com", // empty label
      "example.9x", // TLD starting with a digit
    ]) {
      const res = await requestIcon(domain);
      expect(res.status, domain).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a syntactically valid but blocked host before the cache", async () => {
    const res = await requestIcon("foo.localhost");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("records a negative when DNS answers with a private address", async () => {
    lookupMock.mockResolvedValue(PRIVATE_A as never);

    const res = await requestIcon("rebind.example.com");

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect that downgrades to http", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(redirectResponse("http://example.com/favicon.ico"));

    const res = await requestIcon("example.com");

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect whose target resolves private", async () => {
    lookupMock.mockImplementation(async (host: unknown) =>
      (host === "internal.example.com" ? PRIVATE_A : PUBLIC_A) as never,
    );
    fetchMock.mockResolvedValue(
      redirectResponse("https://internal.example.com/favicon.ico"),
    );

    const res = await requestIcon("example.com");

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a literal private target without resolving it", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(redirectResponse("https://127.0.0.1/favicon.ico"));

    const res = await requestIcon("example.com");

    expect(res.status).toBe(404);
    // one lookup for the origin domain, none for the blocked literal hop
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after three redirect hops", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    let hop = 0;
    fetchMock.mockImplementation(async () => {
      hop += 1;
      return redirectResponse(`https://hop${hop}.example.com/favicon.ico`);
    });

    const res = await requestIcon("example.com");

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial attempt + 3 hops
  });

  it("treats a body over 256 KiB as a miss and never stores truncated bytes", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    const oversize = Buffer.concat([ICO, Buffer.alloc(256 * 1024)]);
    fetchMock.mockResolvedValue(imageResponse(oversize, "image/x-icon"));

    const res = await requestIcon("example.com");

    expect(res.status).toBe(404);
    const stored = await fs.readdir(path.join(directory, "v1"));
    expect(stored.filter((name) => name.endsWith(".icon"))).toEqual([]);
  });

  it("treats a 1x1 tracking-pixel PNG as a miss and serves a real PNG", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValueOnce(imageResponse(testPng(1, 1), "image/png"));
    const pixel = await requestIcon("pixel.example.com");
    expect(pixel.status).toBe(404);
    expect(pixel.headers.get("cache-control")).toBe("private, max-age=86400");

    fetchMock.mockResolvedValueOnce(imageResponse(testPng(16, 16), "image/png"));
    const logo = await requestIcon("logo.example.com");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
  });

  it("rejects SVG and HTML bodies by magic bytes, ignoring Content-Type", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValueOnce(imageResponse(SVG, "image/svg+xml"));
    expect((await requestIcon("svg.example.com")).status).toBe(404);

    fetchMock.mockResolvedValueOnce(imageResponse(HTML, "image/x-icon"));
    expect((await requestIcon("html.example.com")).status).toBe(404);
  });

  it("serves an ICO with sniffed type, length, and immutable private caching", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(ICO, "text/plain"));

    const res = await requestIcon("example.com");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect(res.headers.get("content-length")).toBe(String(ICO.byteLength));
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await res.arrayBuffer()).equals(ICO)).toBe(true);
  });

  it("sniffs PNG bytes served under a lying Content-Type", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(PNG, "text/html"));

    const res = await requestIcon("png.example.com");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("serves a second request from disk without refetching", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(ICO));
    expect((await requestIcon("example.com")).status).toBe(200);

    fetchMock.mockClear();
    lookupMock.mockClear();

    const res = await requestIcon("example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("collapses concurrent requests for one domain into a single fetch", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    let release: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const first = requestIcon("example.com");
    const second = requestIcon("example.com");
    // let both requests pass the cache probe and join the in-flight promise
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(imageResponse(ICO));

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours a fresh negative marker without any network activity", async () => {
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(HTML));
    expect((await requestIcon("no-icon.example.com")).status).toBe(404);

    fetchMock.mockClear();
    lookupMock.mockClear();

    const res = await requestIcon("no-icon.example.com");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("retries after a negative marker expires", async () => {
    const hash = createHash("sha256").update("stale.example.com").digest("hex");
    await fs.mkdir(path.join(directory, "v1"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "v1", `${hash}.miss`),
      JSON.stringify({
        v: 1,
        domain: "stale.example.com",
        fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    );
    lookupMock.mockResolvedValue(PUBLIC_A as never);
    fetchMock.mockResolvedValue(imageResponse(ICO));

    const res = await requestIcon("stale.example.com");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
