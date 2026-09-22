import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const readAppFile = vi.fn();
const readAppMeta = vi.fn();
const verifySession = vi.fn();

vi.mock("@/lib/store", () => ({
  getStore: async () => ({ readAppFile, readAppMeta }),
  NOTES_ROOT: "/notes",
}));
// The signing key comes through the same mock, so minting here and verifying
// below share one key, exactly as they share the installation's in production.
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "brain_session",
  verifySession,
  appFrameSigningKey: () =>
    new TextEncoder().encode("frame-mint-suite-key-not-for-production"),
}));

const { POST } = await import("./route");
const { verifyAppFrameToken, APP_FRAME_TOKEN_MAX_AGE_SECONDS } = await import(
  "@/lib/apps/frame-token"
);

beforeAll(() => {
  process.env.AUTH_SECRET = "frame-mint-suite-secret-not-for-production";
});

const request = () =>
  new NextRequest(new URL("/api/app/app1/frame", "https://brain.example"), {
    method: "POST",
  });
const params = (id = "app1") => ({ params: Promise.resolve({ id }) });

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
    data: new TextEncoder().encode("<!doctype html>"),
  });
});

describe("the address the canvas mounts", () => {
  it("answers an address whose token is this app's, and when it dies", async () => {
    const res = await POST(request(), params());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { src: string; exp: number };

    const token = body.src.split("/t/")[1]?.split("/")[0] ?? "";
    await expect(verifyAppFrameToken(token, "app1")).resolves.toEqual({
      kind: "owner",
    });
    expect(body.src).toBe(`/api/app/app1/t/${token}/index.html`);
    // The entry and every asset hang off the same prefix, which is what lets
    // a relative `assets/x.png` inside the frame carry the token.
    expect(body.src.startsWith(`/api/app/app1/t/${token}/`)).toBe(true);

    const now = Math.floor(Date.now() / 1000);
    expect(body.exp).toBeGreaterThan(now);
    expect(body.exp).toBeLessThanOrEqual(now + APP_FRAME_TOKEN_MAX_AGE_SECONDS);
  });

  it("mints nothing without a session", async () => {
    // This is the one route under /api/app/ that reads the cookie, and it is
    // the one that hands out a capability. The wall lets it through so the
    // frame's own files can reach their route; this is where the owner is
    // actually checked.
    verifySession.mockResolvedValue(false);
    const res = await POST(request(), params());
    expect(res.status).toBe(401);
    expect(readAppMeta).not.toHaveBeenCalled();
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("answers 404 when the entry is not on disk, which is the canvas's other state", async () => {
    readAppFile.mockResolvedValue({ kind: "missing" });
    const res = await POST(request(), params());
    expect(res.status).toBe(404);
  });

  it("answers 404 for a page that is not an app", async () => {
    readAppMeta.mockReturnValue(null);
    const res = await POST(request(), params());
    expect(res.status).toBe(404);
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it("is never cached, because the token in it expires", async () => {
    const res = await POST(request(), params());
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("mints a token that opens only the app it was asked for", async () => {
    const res = await POST(request(), params("app1"));
    const body = (await res.json()) as { src: string };
    const token = body.src.split("/t/")[1]?.split("/")[0] ?? "";
    await expect(verifyAppFrameToken(token, "app2")).resolves.toBeNull();
  });
});
