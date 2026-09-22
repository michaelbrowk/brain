import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_FRAME_TOKEN_MAX_AGE_SECONDS,
  mintAppFrameToken,
  verifyAppFrameToken,
} from "./frame-token";

beforeAll(() => {
  process.env.AUTH_SECRET = "frame-token-suite-secret-not-for-production";
});

const soon = () => Math.floor(Date.now() / 1000) + 600;

describe("the token in an app frame's address", () => {
  it("carries the owner's grant back out again", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "owner" },
      exp: soon(),
    });
    await expect(verifyAppFrameToken(token, "app1")).resolves.toEqual({
      kind: "owner",
    });
  });

  it("carries a visitor's root and version back out again", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "share", root: "root1", version: 3 },
      exp: soon(),
    });
    await expect(verifyAppFrameToken(token, "app1")).resolves.toEqual({
      kind: "share",
      root: "root1",
      version: 3,
    });
  });

  it("is spendable only at the page it was minted for", async () => {
    // The whole reason the page id is in the token and not only in the path:
    // an owner who can see one app must not be able to move its token onto
    // another app's address and read that one's files.
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "owner" },
      exp: soon(),
    });
    await expect(verifyAppFrameToken(token, "app2")).resolves.toBeNull();
  });

  it("refuses a token whose bytes were changed", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "share", root: "root1", version: 3 },
      exp: soon(),
    });
    const [head, body, signature] = token.split(".");
    // A payload rewritten to widen the grant, re-encoded, and signed with
    // nothing. The address is public: anybody who can read a frame's URL can
    // try this.
    const widened = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")),
        grant: { kind: "owner" },
      }),
    ).toString("base64url");
    await expect(verifyAppFrameToken(`${head}.${widened}.${signature}`, "app1"))
      .resolves.toBeNull();
    await expect(verifyAppFrameToken(`${head}.${body}.${signature}x`, "app1"))
      .resolves.toBeNull();
    await expect(verifyAppFrameToken("not-a-token", "app1")).resolves.toBeNull();
    await expect(verifyAppFrameToken("", "app1")).resolves.toBeNull();
  });

  it("stops being spendable when it expires", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "owner" },
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(verifyAppFrameToken(token, "app1")).resolves.toBeNull();
  });

  it("dies when the share it was cut from is rotated", async () => {
    // A revoke bumps `shareVersion`. The token names the version it was minted
    // under and the route compares it with the live one, so a link that was
    // withdrawn cannot go on serving an app's files until the token ages out.
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "share", root: "root1", version: 3 },
      exp: soon(),
    });
    const grant = await verifyAppFrameToken(token, "app1");
    expect(grant).toEqual({ kind: "share", root: "root1", version: 3 });
    // The route's own comparison, stated here so the token's half of it is
    // pinned: the number in the token is the number that was live.
    expect(grant?.kind === "share" && grant.version).toBe(3);
  });

  it("goes in a URL path segment without being escaped", async () => {
    const token = await mintAppFrameToken({
      pageId: "app1",
      grant: { kind: "share", root: "root1", version: 3 },
      exp: soon(),
    });
    // base64url plus the two dots a compact JWS uses, all of which are
    // path-safe. A token that needed escaping would break the relative
    // `assets/x.png` the whole shape exists to serve.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("names twelve hours as the owner's window", () => {
    expect(APP_FRAME_TOKEN_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
  });

  it("refuses to mint for something that is not a page id", async () => {
    // The id lands in a URL path and in the frame's CSP. Neither may take a
    // slash, a space or a newline from a caller.
    for (const pageId of ["", "a/b", "a b", "a\nb", "../x"]) {
      await expect(
        mintAppFrameToken({ pageId, grant: { kind: "owner" }, exp: soon() }),
      ).rejects.toThrow();
    }
  });
});
