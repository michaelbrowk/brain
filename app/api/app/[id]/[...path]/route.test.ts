import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const readAppFile = vi.fn();
const readAppMeta = vi.fn();
const verifySession = vi.fn();
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
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "brain_session", verifySession }));
vi.mock("@/lib/share-access", async () => ({
  resolveShareAccess,
  ShareAccessBusyError: class extends Error {},
  ShareAccessNotFoundError: class extends Error {},
}));

const { GET } = await import("./route");
const { appFrameCsp } = await import("@/lib/apps/csp");

const ENTRY = '<!doctype html><meta name="color-scheme" content="light dark">';

function request(url: string) {
  return new NextRequest(new URL(url, "https://brain.example"));
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(true);
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
  it("serves the entry to the owner", async () => {
    const res = await GET(request("/api/app/app1/index.html"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toContain("color-scheme");
    expect(readAppFile).toHaveBeenCalledWith("app1", "app/index.html");
  });

  it("carries the policy for this origin and this app, on every file", async () => {
    const expected = appFrameCsp("https://brain.example", "app1");
    const entry = await GET(request("/api/app/app1/index.html"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(entry.headers.get("Content-Security-Policy")).toBe(expected);

    const asset = await GET(request("/api/app/app1/assets/a.png"), {
      params: Promise.resolve({ id: "app1", path: ["assets", "a.png"] }),
    });
    expect(asset.headers.get("Content-Security-Policy")).toBe(expected);
  });

  it("builds the origin from the request it is answering, not from a header", async () => {
    const forged = new NextRequest(new URL("/api/app/app1/index.html", "https://brain.example"), {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    const res = await GET(forged, { params: Promise.resolve({ id: "app1", path: ["index.html"] }) });
    expect(res.headers.get("Content-Security-Policy")).toContain("https://brain.example");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("evil.example");
  });

  it("names the configured public origin when there is one, whatever the request URL says", async () => {
    // Behind nginx the request Next sees is addressed to the bind host; the
    // browser fetches assets from the public address, which is what the
    // policy must name.
    configuredPublicOrigin.mockReturnValue("https://brain.public.example");
    const proxied = new NextRequest(new URL("/api/app/app1/index.html", "http://127.0.0.1:3000"));
    const res = await GET(proxied, { params: Promise.resolve({ id: "app1", path: ["index.html"] }) });
    expect(res.headers.get("Content-Security-Policy")).toBe(
      appFrameCsp("https://brain.public.example", "app1"),
    );
    expect(res.headers.get("Content-Security-Policy")).not.toContain("127.0.0.1");
    configuredPublicOrigin.mockReturnValue(null);
  });

  it("maps an asset URL onto the app's assets folder", async () => {
    readAppFile.mockResolvedValue({
      kind: "file",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const res = await GET(request("/api/app/app1/assets/cards/front.png"), {
      params: Promise.resolve({ id: "app1", path: ["assets", "cards", "front.png"] }),
    });
    expect(res.status).toBe(200);
    expect(readAppFile).toHaveBeenCalledWith("app1", "app/assets/cards/front.png");
  });

  it("refuses everything else at that address", async () => {
    for (const path of [["state.json"], ["app", "index.html"], ["..", "index.md"], ["index.md"]]) {
      const res = await GET(request("/api/app/app1/x"), {
        params: Promise.resolve({ id: "app1", path }),
      });
      expect(res.status).toBe(404);
    }
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("answers 404 to a visitor with no session and no grant", async () => {
    verifySession.mockResolvedValue(false);
    const res = await GET(request("/api/app/app1/index.html"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("serves a visitor whose grant reaches the app", async () => {
    verifySession.mockResolvedValue(false);
    resolveShareAccess.mockResolvedValue({ kind: "granted", shareVersion: 3 });
    const res = await GET(
      request("/api/app/app1/index.html?root=root1&v=3"),
      { params: Promise.resolve({ id: "app1", path: ["index.html"] }) },
    );
    expect(res.status).toBe(200);
    expect(resolveShareAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rootId: "root1", targetId: "app1", requestedVersion: "3" }),
    );
  });

  it("answers 404 for a page whose app map does not parse, before it reads a file", async () => {
    // `readAppMeta` validates the frontmatter map and answers null for a
    // hand-written or half-restored one. A page whose map does not parse is
    // not an app, whatever its `kind` says, so nothing of it is served.
    readAppMeta.mockReturnValue(null);
    const res = await GET(request("/api/app/app1/index.html"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("answers 404 for a page that is not an app", async () => {
    readAppFile.mockResolvedValue({ kind: "missing" });
    const res = await GET(request("/api/app/page1/index.html"), {
      params: Promise.resolve({ id: "page1", path: ["index.html"] }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a visitor whose grant stops short of one", async () => {
    // `password-required` is the other kind the resolver answers with, and it
    // is the link whose password has not been entered in this browser. An app
    // is not a preview: nothing of it is served until the grant says granted.
    // Without this case the whole check can be deleted and the suite stays
    // green.
    verifySession.mockResolvedValue(false);
    resolveShareAccess.mockResolvedValue({
      kind: "password-required",
      root: { id: "root1" },
      shareVersion: 3,
    });
    const res = await GET(request("/api/app/app1/index.html?root=root1&v=3"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("refuses a visitor the resolver cannot find a grant for at all", async () => {
    // A root that does not contain this page, a page in the trash, a link
    // that was revoked or has expired, a version older than the one the link
    // now serves: every one of those reaches the route as this error, and
    // every one of them is the same 404 a stranger gets.
    verifySession.mockResolvedValue(false);
    const { ShareAccessNotFoundError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessNotFoundError());
    const res = await GET(request("/api/app/app1/index.html?root=root1&v=9"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("refuses a visitor who names no root or no version", async () => {
    // The two the grant is resolved from. A link visitor without them is a
    // stranger, and guessing either for them would be the route granting
    // itself access.
    for (const url of [
      "/api/app/app1/index.html",
      "/api/app/app1/index.html?root=root1",
      "/api/app/app1/index.html?v=3",
    ]) {
      vi.clearAllMocks();
      verifySession.mockResolvedValue(false);
      const res = await GET(request(url), {
        params: Promise.resolve({ id: "app1", path: ["index.html"] }),
      });
      expect(res.status).toBe(404);
      expect(resolveShareAccess).not.toHaveBeenCalled();
      expect(readAppFile).not.toHaveBeenCalled();
    }
  });

  it("answers 503 while the share is being read and cannot be settled", async () => {
    verifySession.mockResolvedValue(false);
    const { ShareAccessBusyError } = await import("@/lib/share-access");
    resolveShareAccess.mockRejectedValue(new ShareAccessBusyError());
    const res = await GET(request("/api/app/app1/index.html?root=root1&v=3"), {
      params: Promise.resolve({ id: "app1", path: ["index.html"] }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("refuses a traversal in the URL before the store is asked", async () => {
    // The store's own `appAssetPath` is the lock that decides an asset name.
    // This is the first one, and it exists so a `..` never becomes a path at
    // all. Without this case it can be deleted and the suite stays green.
    for (const path of [
      ["assets", "..", "index.html"],
      ["assets", "cards", "..", "..", "index.html"],
      ["assets", "."],
      ["assets", "..", "..", "..", "etc", "passwd"],
    ]) {
      vi.clearAllMocks();
      verifySession.mockResolvedValue(true);
      const res = await GET(request("/api/app/app1/x"), {
        params: Promise.resolve({ id: "app1", path }),
      });
      expect(res.status).toBe(404);
      expect(readAppFile).not.toHaveBeenCalled();
    }
  });

  it("types every answer nosniff, so a served asset is what it says it is", async () => {
    // The config block sets this too, and this one is the route's own: an
    // asset whose bytes disagree with its name must not be sniffed into
    // something executable, and a response that leaves this file already
    // carries the answer.
    readAppFile.mockResolvedValue({
      kind: "file",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const res = await GET(request("/api/app/app1/assets/a.png"), {
      params: Promise.resolve({ id: "app1", path: ["assets", "a.png"] }),
    });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe("3");
  });
});
