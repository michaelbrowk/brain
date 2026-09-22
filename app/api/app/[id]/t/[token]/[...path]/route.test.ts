import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const readAppFile = vi.fn();
const readAppMeta = vi.fn();
const resolveShareAccess = vi.fn();
// Null by default: the request URL's own origin is the policy's, as on an
// install with no public origin configured. One test sets it.
const configuredPublicOrigin = vi.fn<() => string | null>(() => null);

vi.mock("@/lib/store", () => ({
  getStore: async () => ({
    readAppFile,
    readAppMeta,
    isWithinSubtree: () => true,
    isDeleted: () => false,
  }),
  configuredPublicOrigin,
  NOTES_ROOT: "/notes",
}));
vi.mock("@/lib/share-access", async () => ({
  resolveShareAccess,
  ShareAccessBusyError: class extends Error {},
  ShareAccessNotFoundError: class extends Error {},
}));

const { GET, HEAD } = await import("./route");
const { appFrameCsp } = await import("@/lib/apps/csp");
const { mintAppFrameToken } = await import("@/lib/apps/frame-token");

const ENTRY = '<!doctype html><meta name="color-scheme" content="light dark">';

beforeAll(() => {
  process.env.AUTH_SECRET = "app-route-suite-secret-not-for-production";
});

const soon = () => Math.floor(Date.now() / 1000) + 600;
const ownerToken = (pageId = "app1") =>
  mintAppFrameToken({ pageId, grant: { kind: "owner" }, exp: soon() });
const shareToken = (root = "root1", version = 3, pageId = "app1") =>
  mintAppFrameToken({ pageId, grant: { kind: "share", root, version }, exp: soon() });

function request(url: string) {
  return new NextRequest(new URL(url, "https://brain.example"));
}

/** The shape the route is mounted at. The token is its own segment so a
 *  relative `assets/x.png` inside the frame carries it without the document
 *  having to rewrite anything. */
function params(token: string, path: string[], id = "app1") {
  return { params: Promise.resolve({ id, token, path }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  readAppMeta.mockReturnValue({
    entry: "app/index.html",
    version: 1,
    builtBy: "Claude",
    builtAt: "2026-09-22T10:00:00.000Z",
    owns: [],
    state: false,
  });
  readAppFile.mockResolvedValue({
    kind: "file",
    mimeType: "text/html; charset=utf-8",
    data: new TextEncoder().encode(ENTRY),
  });
});

describe("an app's files", () => {
  it("serves the entry to a token the owner was given", async () => {
    const token = await ownerToken();
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toContain("color-scheme");
    expect(readAppFile).toHaveBeenCalledWith("app1", "app/index.html");
  });

  it("serves an asset under the same token, which is the whole point of the shape", async () => {
    // The frame's `<img src="assets/cards/front.png">` is relative, so the
    // browser resolves it against the entry's path and the token rides along
    // by construction. Nothing in the document has to know the token exists.
    readAppFile.mockResolvedValue({
      kind: "file",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const token = await ownerToken();
    const res = await GET(
      request(`/api/app/app1/t/${token}/assets/cards/front.png`),
      params(token, ["assets", "cards", "front.png"]),
    );
    expect(res.status).toBe(200);
    expect(readAppFile).toHaveBeenCalledWith("app1", "app/assets/cards/front.png");
  });

  it("reads no cookie at all", async () => {
    // The frame's requests are cross-site and carry none. A route that asked
    // for one would serve the document and refuse every file under it.
    const token = await ownerToken();
    const withCookies = new NextRequest(
      new URL(`/api/app/app1/t/${token}/index.html`, "https://brain.example"),
      { headers: { cookie: "brain_session=anything; brain_share_root1=anything" } },
    );
    expect((await GET(withCookies, params(token, ["index.html"]))).status).toBe(200);

    // And no cookie rescues a request whose token is not one.
    const refused = await GET(
      new NextRequest(
        new URL("/api/app/app1/t/not-a-token/index.html", "https://brain.example"),
        { headers: { cookie: "brain_session=anything" } },
      ),
      params("not-a-token", ["index.html"]),
    );
    expect(refused.status).toBe(404);
  });

  it("carries the policy for this origin and this app, on every file", async () => {
    const expected = appFrameCsp("https://brain.example", "app1");
    const token = await ownerToken();
    const entry = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(entry.headers.get("Content-Security-Policy")).toBe(expected);

    const asset = await GET(
      request(`/api/app/app1/t/${token}/assets/a.png`),
      params(token, ["assets", "a.png"]),
    );
    expect(asset.headers.get("Content-Security-Policy")).toBe(expected);
    // The host-source has to be a prefix of the address the frame will ask
    // from, or the browser refuses the asset before the route ever sees it.
    expect(expected).toContain("https://brain.example/api/app/app1/t/");
  });

  it("builds the origin from the request it is answering, not from a header", async () => {
    const token = await ownerToken();
    const forged = new NextRequest(
      new URL(`/api/app/app1/t/${token}/index.html`, "https://brain.example"),
      { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } },
    );
    const res = await GET(forged, params(token, ["index.html"]));
    expect(res.headers.get("Content-Security-Policy")).toContain("https://brain.example");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("evil.example");
  });

  it("names the configured public origin when there is one, whatever the request URL says", async () => {
    // Behind nginx the request Next sees is addressed to the bind host; the
    // browser fetches assets from the public address, which is what the
    // policy must name.
    configuredPublicOrigin.mockReturnValue("https://brain.public.example");
    const token = await ownerToken();
    const proxied = new NextRequest(
      new URL(`/api/app/app1/t/${token}/index.html`, "http://127.0.0.1:3000"),
    );
    const res = await GET(proxied, params(token, ["index.html"]));
    expect(res.headers.get("Content-Security-Policy")).toBe(
      appFrameCsp("https://brain.public.example", "app1"),
    );
    // Named against the request's own origin as NextURL resolved it, rather
    // than against a string this test wrote: an assertion on a host the
    // request does not have could never fail.
    expect(res.headers.get("Content-Security-Policy")).not.toContain(
      proxied.nextUrl.origin,
    );
    configuredPublicOrigin.mockReturnValue(null);
  });

  it("refuses everything else at that address", async () => {
    const token = await ownerToken();
    for (const path of [["state.json"], ["app", "index.html"], ["..", "index.md"], ["index.md"]]) {
      const res = await GET(request(`/api/app/app1/t/${token}/x`), params(token, path));
      expect(res.status).toBe(404);
    }
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("refuses a request with no usable token, before it asks the store anything", async () => {
    for (const token of ["", "not-a-token", "a.b.c", "..", "%2e%2e"]) {
      vi.clearAllMocks();
      const res = await GET(
        request(`/api/app/app1/t/${encodeURIComponent(token)}/index.html`),
        params(token, ["index.html"]),
      );
      expect(res.status).toBe(404);
      expect(readAppFile).not.toHaveBeenCalled();
      expect(readAppMeta).not.toHaveBeenCalled();
    }
  });

  it("refuses a token minted for another app", async () => {
    // The address is public. Without the binding, somebody holding one app's
    // token could move it onto another app's path and read that one's files.
    const token = await ownerToken("app2");
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("refuses a token that has expired", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "owner" },
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(404);
  });

  it("serves a visitor whose token still resolves to a live grant", async () => {
    resolveShareAccess.mockResolvedValue({ kind: "granted", shareVersion: 3 });
    const token = await shareToken("root1", 3);
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(200);
    expect(resolveShareAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rootId: "root1",
        targetId: "app1",
        requestedVersion: "3",
      }),
    );
  });

  it("asks the live share on every request, so a revoke stops it at once", async () => {
    // The token is a bearer capability with hours left on it. What stops a
    // withdrawn link is this call, not the expiry.
    const { ShareAccessNotFoundError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessNotFoundError());
    const token = await shareToken("root1", 3);
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("dies when the share is rotated under it", async () => {
    // A revoke bumps the version. The token still names the old one, the
    // resolver is asked for that version and answers not-found, and the app
    // stops serving without anybody clearing a cache.
    const { ShareAccessNotFoundError } = await import("@/lib/share-access");
    resolveShareAccess.mockImplementation(
      async (_store: unknown, input: { requestedVersion?: string }) => {
        if (input.requestedVersion !== "4") throw new ShareAccessNotFoundError();
        return { kind: "granted", shareVersion: 4 };
      },
    );
    const stale = await shareToken("root1", 3);
    expect(
      (await GET(request(`/api/app/app1/t/${stale}/index.html`), params(stale, ["index.html"])))
        .status,
    ).toBe(404);

    const fresh = await shareToken("root1", 4);
    expect(
      (await GET(request(`/api/app/app1/t/${fresh}/index.html`), params(fresh, ["index.html"])))
        .status,
    ).toBe(200);
  });

  it("refuses a visitor whose grant stops short of one", async () => {
    resolveShareAccess.mockResolvedValue({
      kind: "password-required",
      root: { id: "root1" },
      shareVersion: 3,
    });
    const token = await shareToken("root1", 3);
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("answers 503 while the share is being read and cannot be settled", async () => {
    const { ShareAccessBusyError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessBusyError());
    const token = await shareToken("root1", 3);
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("asks the share resolver nothing for an owner's token", async () => {
    const token = await ownerToken();
    await GET(request(`/api/app/app1/t/${token}/index.html`), params(token, ["index.html"]));
    expect(resolveShareAccess).not.toHaveBeenCalled();
  });

  it("answers 404 for a page whose app map does not parse, before it reads a file", async () => {
    readAppMeta.mockReturnValue(null);
    const token = await ownerToken();
    const res = await GET(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("answers 404 for a page that is not an app", async () => {
    readAppFile.mockResolvedValue({ kind: "missing" });
    const token = await ownerToken("page1");
    const res = await GET(
      request(`/api/app/page1/t/${token}/index.html`),
      params(token, ["index.html"], "page1"),
    );
    expect(res.status).toBe(404);
  });

  it("refuses a traversal in the URL before the store is asked", async () => {
    const token = await ownerToken();
    for (const path of [
      ["assets", "..", "index.html"],
      ["assets", "cards", "..", "..", "index.html"],
      ["assets", "."],
      ["assets", "..", "..", "..", "etc", "passwd"],
    ]) {
      vi.clearAllMocks();
      const res = await GET(request(`/api/app/app1/t/${token}/x`), params(token, path));
      expect(res.status).toBe(404);
      expect(readAppFile).not.toHaveBeenCalled();
    }
  });

  it("types every answer nosniff, so a served asset is what it says it is", async () => {
    readAppFile.mockResolvedValue({
      kind: "file",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const token = await ownerToken();
    const res = await GET(
      request(`/api/app/app1/t/${token}/assets/a.png`),
      params(token, ["assets", "a.png"]),
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe("3");
  });

  it("answers HEAD with the same decision and none of the work", async () => {
    const token = await ownerToken();
    const res = await HEAD(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      appFrameCsp("https://brain.example", "app1"),
    );
    expect(res.headers.get("Content-Length")).toBeNull();
  });

  it("refuses a HEAD everywhere it refuses a GET", async () => {
    const token = await ownerToken();
    const noToken = await HEAD(
      request("/api/app/app1/t/not-a-token/index.html"),
      params("not-a-token", ["index.html"]),
    );
    expect(noToken.status).toBe(404);

    const wrongPath = await HEAD(
      request(`/api/app/app1/t/${token}/x`),
      params(token, ["state.json"]),
    );
    expect(wrongPath.status).toBe(404);

    readAppFile.mockResolvedValue({ kind: "missing" });
    const gone = await HEAD(
      request(`/api/app/app1/t/${token}/index.html`),
      params(token, ["index.html"]),
    );
    expect(gone.status).toBe(404);
  });

  it("says once when a proxy is in front and no public origin is configured", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = await import("./route");
      const token = await ownerToken();
      const proxied = new NextRequest(
        new URL(`/api/app/app1/t/${token}/index.html`, "http://127.0.0.1:3000"),
        { headers: { "x-forwarded-host": "brain.example" } },
      );

      configuredPublicOrigin.mockReturnValue("https://brain.public.example");
      await fresh.GET(proxied, params(token, ["index.html"]));
      expect(warn).not.toHaveBeenCalled();

      configuredPublicOrigin.mockReturnValue(null);
      const first = await fresh.GET(proxied, params(token, ["index.html"]));
      await fresh.GET(proxied, params(token, ["index.html"]));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("BRAIN_PUBLIC_ORIGIN");
      expect(first.headers.get("Content-Security-Policy")).toBe(
        appFrameCsp(proxied.nextUrl.origin, "app1"),
      );
      expect(first.headers.get("Content-Security-Policy")).not.toContain("brain.example");
    } finally {
      warn.mockRestore();
      configuredPublicOrigin.mockReturnValue(null);
    }
  });
});
